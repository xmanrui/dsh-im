import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * 记忆库的 schema 版本，写进 PRAGMA user_version 的低位。
 * 目前只有 1；以后加列时靠它判断是否需要迁移。
 */
export const MEMORY_DOCUMENT_VERSION = 1;

/**
 * 「本机 SQLite 没有 FTS5」标记位，和版本号共用 user_version。
 * 置位后重开库时直接跳过 FTS 探测，否则每次 open 都要吞一次 SQL 异常。
 */
const FTS_DEGRADED_BIT = 0x4000_0000;

/** 记忆库固定文件名。同一 root 上重复 new MemoryStore 会落到同一个库（ready() 幂等）。 */
const DATABASE_FILE = 'memory.sqlite';

/** scope 白名单：微信侧形如 weixin:<botId>:<conversationKey>，不允许空格、引号、通配符。 */
const SCOPE_PATTERN = /^[A-Za-z0-9_:.-]{1,256}$/;

/** 槽位名沿用同一套字符集，只是更短。 */
const SLOT_NAME_PATTERN = /^[A-Za-z0-9_:.-]{1,128}$/;

/** 会撞坏普通对象原型的槽位名，一律拒绝（否则 slots() 的返回值会被污染）。 */
const RESERVED_SLOT_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 100;
const DEFAULT_FLUSH_THRESHOLD = 16;
const DEFAULT_MAX_AGE_DAYS = 90;
const MAX_FIELD_LENGTH = 2000;
const MAX_TOKEN_LENGTH = 64;
const MAX_QUERY_TOKENS = 8;
const CANDIDATE_LIMIT = 200;
const DEFAULT_MAX_CHARS = 1200;

/** 时间衰减系数：每过 30 天，分数乘上 e^-1。新旧事实的差距按天数指数拉开。 */
const DECAY_LAMBDA = 1 / 30;

/** FTS 探测词。trigram 分词器要求至少 3 个字符，用一个与业务无关的长词探测。 */
const FTS_PROBE_TERM = '"memoryprobe"';

const FACT_HEADING = '## 你记得的事';
const SLOT_HEADING = '## 你对这个群的印象';

/** 统一带 code 的错误，调用方靠 error.code 分流，不靠 message 文本。 */
function memoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 校验并返回 scope。scope 是每条 SQL 的第一个条件，先过白名单再进库：
 * 长度、字符集都在这里卡死，后面所有查询直接信任它。
 */
function checkedScope(scope) {
  if (typeof scope === 'string' && SCOPE_PATTERN.test(scope)) return scope;
  throw memoryError('memory-scope-invalid', '记忆库 scope 非法：只允许 [A-Za-z0-9_:.-]{1,256}。');
}

/** 槽位名同样先白名单再进库，并挡掉原型链上的保留名。 */
function checkedSlotName(name) {
  if (typeof name === 'string' && SLOT_NAME_PATTERN.test(name) && !RESERVED_SLOT_NAMES.has(name)) return name;
  throw memoryError('memory-slot-invalid', '槽位名非法：只允许 [A-Za-z0-9_:.-]{1,128}，且不能是保留名。');
}

/** 事实的文本字段：必须是字符串、去空白后非空、截到列上限。 */
function requiredText(value, field) {
  if (typeof value !== 'string') throw memoryError('memory-fact-invalid', '记忆字段 ' + field + ' 必须是字符串。');
  const trimmed = value.trim();
  if (!trimmed) throw memoryError('memory-fact-invalid', '记忆字段 ' + field + ' 不能为空。');
  return trimmed.slice(0, MAX_FIELD_LENGTH);
}

/** confidence 归一到 [0, 1]；非法值退回 1（默认当作可信）。 */
function checkedConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

/** 时间戳统一用毫秒整数；非法输入退回 fallback，避免 NaN 写进 INTEGER 列。 */
function checkedMillis(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** 数据库行 -> 对外的驼峰事实对象。列名只在这里翻译一次。 */
function factView(row) {
  return {
    id: row.id,
    scope: row.scope,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    supersededBy: row.superseded_by,
    sourceMessageId: row.source_message_id,
    confidence: row.confidence,
  };
}

/**
 * 把检索词切成词元：全角空格先归一成半角，再按半角空格切分，
 * 去重、限量、截断。空查询返回空数组（调用方据此返回空结果）。
 */
function queryTokens(query) {
  if (typeof query !== 'string') return [];
  const normalized = query.replaceAll(String.fromCharCode(0x3000), ' ');
  const seen = new Set();
  const tokens = [];
  for (const raw of normalized.split(' ')) {
    const token = raw.trim().slice(0, MAX_TOKEN_LENGTH);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

/**
 * 生成 LIKE 模式串。转义符选 ! 而不是反斜杠：反斜杠本身要在 JS 与 SQL 各转义一次，
 * 用 ! 只需在 SQL 里声明 ESCAPE '!'。先加倍 ! 再转义 % 与 _，顺序反了会二次转义。
 */
function likePattern(token) {
  const escaped = token.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
  return '%' + escaped + '%';
}

/**
 * 给一条候选事实打分：相关度（命中词占比）乘时间衰减 exp(-lambda * 天数)。
 * 衰减只做相对排序，不会把旧事实直接抹零，所以旧记忆仍然可能被召回。
 */
function scoreRow(row, tokens, at) {
  const fact = factView(row);
  const haystack = (fact.object + ' ' + fact.subject + ' ' + fact.predicate).toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token.toLowerCase())) hits += 1;
  }
  const ageDays = Math.max(0, at - fact.validFrom) / DAY_MS;
  const score = (1 + hits / tokens.length) * Math.exp(-DECAY_LAMBDA * ageDays);
  return { ...fact, score: Math.round(score * 1e6) / 1e6 };
}

/** 时间戳 -> YYYY-MM-DD。统一用 UTC，保证同一份记忆在不同时区的机器上渲染一致。 */
function formatDay(millis) {
  if (!Number.isSafeInteger(millis) || millis <= 0) return '';
  return new Date(millis).toISOString().slice(0, 10);
}

/** 渲染前把值压成单行：记忆里可能夹带换行，会破坏「- 」列表结构。 */
function oneLine(value) {
  if (typeof value !== 'string') return '';
  return value.replaceAll('\n', ' ').replaceAll('\r', ' ').trim();
}

/** 一条事实 -> 一行文本：对象正文 + 「(YYYY-MM-DD 记)」。 */
function factLine(fact) {
  if (!fact || typeof fact !== 'object') return '';
  const text = oneLine(fact.object);
  if (!text) return '';
  const day = formatDay(fact.validFrom);
  return day ? text + '（' + day + ' 记）' : text;
}

/** 槽位表 -> 文本行。slots() 的返回值是 { [name]: { value, updatedAt } }，这里只取 value。 */
function slotLines(slots) {
  if (!slots || typeof slots !== 'object') return [];
  const lines = [];
  for (const entry of Object.values(slots)) {
    const text = oneLine(typeof entry === 'string' ? entry : entry?.value);
    if (text) lines.push(text);
  }
  return lines;
}

/**
 * 把召回结果与槽位渲染成一段可注入 prompt 的中文文本。
 * 两段都为空时返回空串，调用方可以直接拼接而不用判空。
 * 超出 maxChars 时按整行截断：一行放不下就停，绝不把半句话塞进 prompt。
 */
export function renderMemoryBlock(facts, slots, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS;
  const remembered = (Array.isArray(facts) ? facts : []).map(factLine).filter(Boolean);
  const impressions = slotLines(slots);
  if (remembered.length === 0 && impressions.length === 0) return '';
  const lines = [];
  if (remembered.length) lines.push(FACT_HEADING, ...remembered.map((text) => '- ' + text));
  if (impressions.length) lines.push(SLOT_HEADING, ...impressions.map((text) => '- ' + text));
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const width = kept.length === 0 ? line.length : used + 1 + line.length;
    if (width > limit) break;
    used = width;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * 纯本地记忆库：一台机器一个 SQLite 文件，不联网、不起服务、只依赖 node 内置模块。
 *
 * 两个存储面：facts 存「主体-谓词-客体」三元事实（Zep 语义：新事实让旧事实失效而不删除），
 * slots 存会话级的短槽位（语气、称呼之类，可带 TTL）。
 * 写操作先进内存缓冲，攒够 flushThreshold 或遇到读/关闭时再一次事务落盘。
 */
export class MemoryStore {
  #root;
  #db = null;
  #ready;
  #now;
  #logger;
  #flushThreshold;
  #pending = [];
  #ftsAvailable = false;
  #closed = false;
  #degradedLogged = false;

  /**
   * @param {string} root 数据目录，库文件固定为 root/memory.sqlite
   * @param {{ now?: () => number, logger?: { warn?: Function }, flushThreshold?: number }} [options]
   */
  constructor(root, { now = Date.now, logger = console, flushThreshold = DEFAULT_FLUSH_THRESHOLD } = {}) {
    this.#root = resolve(root);
    this.#now = now;
    this.#logger = logger;
    // 阈值必须是正整数，否则等于每次写都 flush，缓冲就失去意义。
    this.#flushThreshold = Number.isSafeInteger(flushThreshold) && flushThreshold > 0
      ? flushThreshold
      : DEFAULT_FLUSH_THRESHOLD;
  }

  get root() { return this.#root; }

  /** 当前连接是否启用了 FTS5 索引。false 表示召回走 LIKE 降级路径。 */
  get ftsAvailable() { return this.#ftsAvailable; }

  /** 当前时钟读数（毫秒）。默认是 Date.now，测试可注入可推进的假时钟。 */
  now() { return this.#now(); }

  /** 建库建表；幂等，重复调用只建一次（同一个 promise 被复用）。 */
  ready() {
    this.#ready ??= this.#open();
    return this.#ready;
  }

  /** 落盘缓冲后关闭连接；重复调用无副作用。 */
  async close() {
    if (this.#closed) return;
    try {
      if (this.#ready) {
        await this.#ready;
        await this.#flush();
      }
    } finally {
      this.#db?.close();
      this.#db = null;
      this.#closed = true;
    }
  }

  async #open() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const path = join(this.#root, DATABASE_FILE);
    // DatabaseSync 是同步 API：只有 open 这一次重活，之后的读写都是本地微秒级调用。
    this.#db = new DatabaseSync(path);
    // WAL 让「一个进程写、另一个进程读」不互相阻塞；busy_timeout 兜住偶发写冲突。
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA busy_timeout = 3000');
    // facts 存三元事实；(scope, valid_to) 是召回热路径，supersede 的 UPDATE 也吃这个索引。
    this.#db.exec('CREATE TABLE IF NOT EXISTS facts ('
      + 'id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL, '
      + 'object TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER, superseded_by TEXT, '
      + 'source_message_id TEXT, confidence REAL NOT NULL DEFAULT 1)');
    this.#db.exec('CREATE INDEX IF NOT EXISTS facts_scope_active ON facts(scope, valid_to)');
    this.#db.exec('CREATE INDEX IF NOT EXISTS facts_triple ON facts(scope, subject, predicate, valid_to)');
    // slots 以 (scope, name) 为主键，后写覆盖前写；expires_at 为空表示永不过期。
    this.#db.exec('CREATE TABLE IF NOT EXISTS slots ('
      + 'scope TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, '
      + 'updated_at INTEGER NOT NULL, expires_at INTEGER, PRIMARY KEY (scope, name))');
    // 旧版本号要在装 FTS 之前读出来（装 FTS 时可能写入 degrade 标记）。
    const stored = this.#db.prepare('PRAGMA user_version').get();
    const baseVersion = Number(stored?.user_version ?? 0);
    if (baseVersion === 0) this.#db.exec('PRAGMA user_version = ' + MEMORY_DOCUMENT_VERSION);
    this.#ftsAvailable = this.#installFts(baseVersion);
    // 建库之后缓冲一定为空，这里调用一次只是为了让「ready() 会 flush」这条契约始终成立。
    await this.#flush();
    return this;
  }

  /**
   * 装 FTS5 索引与三个同步触发器，返回是否真的装成功。
   * 顺序很关键：先建虚表、再用 MATCH 探测、最后才建触发器 ——
   * 若库里已有一张同名的普通 facts_fts 表，CREATE VIRTUAL TABLE IF NOT EXISTS 会静默成功，
   * 此时触发器一旦建好，之后每次 INSERT facts 都会在触发器里炸掉整个写事务。
   */
  #installFts(baseVersion) {
    if ((baseVersion & FTS_DEGRADED_BIT) !== 0) return false;
    try {
      const existed = this.#db.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'facts_fts'").get();
      this.#db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5('
        + "object, subject, predicate, content='facts', content_rowid='rowid', tokenize='trigram')");
      // 真探测一次 MATCH：同名假表只会在 MATCH 时报 "no such column: facts_fts"。
      this.#db.prepare('SELECT rowid FROM facts_fts WHERE facts_fts MATCH ? LIMIT 1').all(FTS_PROBE_TERM);
      // 索引同步全部交给触发器，JS 侧绝不手工补写索引（漏一处就静默失配）。
      this.#db.exec('CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN '
        + 'INSERT INTO facts_fts(rowid, object, subject, predicate) '
        + 'VALUES (new.rowid, new.object, new.subject, new.predicate); END');
      this.#db.exec('CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN '
        + "INSERT INTO facts_fts(facts_fts, rowid, object, subject, predicate) "
        + "VALUES ('delete', old.rowid, old.object, old.subject, old.predicate); END");
      // UPDATE 只在被检索的三列真的变了时重写索引行：valid_to/superseded_by 的更新不触发，
      // 让「让旧事实失效」这一步保持廉价。
      this.#db.exec('CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts WHEN '
        + 'old.object IS NOT new.object OR old.subject IS NOT new.subject OR old.predicate IS NOT new.predicate BEGIN '
        + "INSERT INTO facts_fts(facts_fts, rowid, object, subject, predicate) "
        + "VALUES ('delete', old.rowid, old.object, old.subject, old.predicate); "
        + 'INSERT INTO facts_fts(rowid, object, subject, predicate) '
        + 'VALUES (new.rowid, new.object, new.subject, new.predicate); END');
      // 虚表是这次新建的：把已存在的 facts 行一次性灌进索引（之前可能是降级运行留下的历史数据）。
      if (!existed) this.#db.exec("INSERT INTO facts_fts(facts_fts) VALUES ('rebuild')");
      return true;
    } catch (error) {
      this.#noteFtsDegraded(error);
      return false;
    }
  }

  /** 记一次降级：日志只打一次，标记写进 user_version 以便下次不再探测。 */
  #noteFtsDegraded(error) {
    if (!this.#degradedLogged) {
      this.#degradedLogged = true;
      this.#logger?.warn?.('[dsh-im] memory store: FTS5 不可用，召回降级为 LIKE 匹配（'
        + (error?.message ?? 'unknown') + '）');
    }
    // 顺手清掉可能残留的触发器，避免它们引用一张不可用的表。
    for (const name of ['facts_fts_ai', 'facts_fts_ad', 'facts_fts_au']) {
      try { this.#db.exec('DROP TRIGGER IF EXISTS ' + name); } catch { /* 清不掉也不影响 LIKE 路径 */ }
    }
    try {
      this.#db.exec('PRAGMA user_version = ' + (MEMORY_DOCUMENT_VERSION | FTS_DEGRADED_BIT));
    } catch { /* 标记写失败只是让下次重新探测，不阻断主流程 */ }
  }

  #assertOpen() {
    if (this.#closed) throw memoryError('memory-store-closed', '记忆库已关闭。');
  }

  /**
   * 写一条事实。同一 (scope, subject, predicate) 的旧事实不删，只被封上有效期末并被标记被谁取代。
   * 返回的对象是「这次写入的意图快照」：validTo/supersededBy 反映入参那一刻的状态，
   * 真正的失效由 flush 时的 UPDATE 完成，因此以 recall 读到的为准。
   *
   * @returns {Promise<{ id: string, scope: string, subject: string, predicate: string, object: string,
   *   validFrom: number, validTo: number | null, supersededBy: string | null,
   *   sourceMessageId: string | null, confidence: number }>}
   */
  async remember({ scope, subject, predicate, object, sourceMessageId = null, confidence = 1 } = {}) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    // 三个文本字段先规整（去空白 + 截断），空值直接拒绝：没有对象的事实没有意义。
    const fact = {
      id: randomUUID(),
      scope: normalizedScope,
      subject: requiredText(subject, 'subject'),
      predicate: requiredText(predicate, 'predicate'),
      object: requiredText(object, 'object'),
      validFrom: checkedMillis(this.#now(), Date.now()),
      validTo: null,
      supersededBy: null,
      sourceMessageId: typeof sourceMessageId === 'string' && sourceMessageId
        ? sourceMessageId.slice(0, 256)
        : null,
      confidence: checkedConfidence(confidence),
    };
    await this.ready();
    this.#pending.push({ type: 'fact', fact });
    await this.#maybeFlush();
    return { ...fact };
  }

  /**
   * 在当前事实里按关键词召回，再按「相关度 x 时间衰减」排序返回。
   * FTS 命中为空或不可用时自动走 LIKE，两条路径都只返回 validTo IS NULL 的当前事实。
   *
   * @returns {Promise<Array<object>>} 每条事实外加 score，按 score 降序
   */
  async recall({ scope, query, limit = DEFAULT_LIMIT, now = this.now() } = {}) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    await this.ready();
    // 读之前先落盘：否则刚 remember 的事实还在缓冲里，召回会「看不见」。
    await this.#flush();
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    const at = checkedMillis(now, this.#now());
    const capped = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
    // 先问 FTS；没命中（含 2 个汉字这种 trigram 无法索引的短词）就退回 LIKE。
    const matched = this.#ftsAvailable ? this.#matchCandidates(normalizedScope, tokens) : [];
    const candidates = matched.length > 0 ? matched : this.#likeCandidates(normalizedScope, tokens);
    return candidates
      .map((row) => scoreRow(row, tokens, at))
      .sort((left, right) => right.score - left.score)
      .slice(0, capped);
  }

  /** FTS 路径：每个词包成双引号短语再 AND 起来，用户文本永远只当字面量，不解释成布尔运算符。 */
  #matchCandidates(scope, tokens) {
    const expression = tokens.map((token) => '"' + token.replaceAll('"', '""') + '"').join(' AND ');
    try {
      return this.#db.prepare('SELECT f.* FROM facts_fts JOIN facts f ON f.rowid = facts_fts.rowid '
        + 'WHERE facts_fts MATCH ? AND f.scope = ? AND f.valid_to IS NULL LIMIT ?')
        .all(expression, scope, CANDIDATE_LIMIT);
    } catch {
      // 索引异常（含 trigram 对过短词的表现）不冒泡：交回 LIKE 兜底，读路径永远可用。
      return [];
    }
  }

  /** LIKE 路径：每个词一组三列 OR，词与词之间 AND；全部走参数绑定，用户文本只当字面量。 */
  #likeCandidates(scope, tokens) {
    const clause = tokens
      .map(() => "(object LIKE ? ESCAPE '!' OR subject LIKE ? ESCAPE '!' OR predicate LIKE ? ESCAPE '!')")
      .join(' AND ');
    const params = [scope];
    for (const token of tokens) {
      const pattern = likePattern(token);
      params.push(pattern, pattern, pattern);
    }
    params.push(CANDIDATE_LIMIT);
    return this.#db.prepare('SELECT * FROM facts WHERE scope = ? AND valid_to IS NULL AND '
      + clause + ' LIMIT ?').all(...params);
  }

  /** 未过期的槽位表：{ [name]: { value, updatedAt } }；expires_at 为空表示永不过期。 */
  async slots(scope) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    await this.ready();
    await this.#flush();
    const rows = this.#db.prepare('SELECT name, value, updated_at FROM slots '
      + 'WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY name')
      .all(normalizedScope, this.#now());
    const result = {};
    // 槽位名已在 checkedSlotName 里挡掉 __proto__ 之类的保留名，这里可以直接赋值。
    for (const row of rows) result[row.name] = { value: row.value, updatedAt: row.updated_at };
    return result;
  }

  /** 写一个槽位；(scope, name) 唯一，后写覆盖前写。ttlMs 为正整数时才设过期时间。 */
  async setSlot(scope, name, value, { ttlMs = null } = {}) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    const normalizedName = checkedSlotName(name);
    const text = typeof value === 'string' ? value : (value === null || value === undefined ? '' : String(value));
    if (!text.trim()) throw memoryError('memory-slot-invalid', '槽位 ' + normalizedName + ' 的值不能为空。');
    const at = checkedMillis(this.#now(), Date.now());
    const slot = {
      scope: normalizedScope,
      name: normalizedName,
      value: text.trim().slice(0, MAX_FIELD_LENGTH),
      updatedAt: at,
      expiresAt: Number.isSafeInteger(ttlMs) && ttlMs > 0 ? at + ttlMs : null,
    };
    await this.ready();
    this.#pending.push({ type: 'slot', slot });
    await this.#maybeFlush();
    return { ...slot };
  }

  /** 硬删一条事实（「忘掉这个」）。返回是否真的删到了。 */
  async forget(scope, factId) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    if (typeof factId !== 'string' || !factId) throw memoryError('memory-fact-invalid', 'forget 需要事实 id。');
    await this.ready();
    // 先落盘缓冲，保证能删到刚 remember 还没 flush 的那条。
    await this.#flush();
    const result = this.#db.prepare('DELETE FROM facts WHERE scope = ? AND id = ?').run(normalizedScope, factId);
    return Number(result.changes) > 0;
  }

  /** 清掉「已失效且失效时间超过 maxAgeDays」的事实，返回删除条数；当前事实一条都不动。 */
  async prune({ scope, maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    const days = Number.isSafeInteger(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULT_MAX_AGE_DAYS;
    await this.ready();
    await this.#flush();
    const cutoff = this.#now() - days * DAY_MS;
    const result = this.#db.prepare('DELETE FROM facts WHERE scope = ? AND valid_to IS NOT NULL AND valid_to < ?')
      .run(normalizedScope, cutoff);
    return Number(result.changes ?? 0);
  }

  /** 计数概览：facts 含已失效的历史，activeFacts 是当前事实，slots 是未过期槽位数。 */
  async stats(scope) {
    this.#assertOpen();
    const normalizedScope = checkedScope(scope);
    await this.ready();
    await this.#flush();
    const facts = this.#db.prepare('SELECT COUNT(*) AS count FROM facts WHERE scope = ?').get(normalizedScope);
    const active = this.#db.prepare('SELECT COUNT(*) AS count FROM facts WHERE scope = ? AND valid_to IS NULL')
      .get(normalizedScope);
    const slots = this.#db.prepare('SELECT COUNT(*) AS count FROM slots '
      + 'WHERE scope = ? AND (expires_at IS NULL OR expires_at > ?)').get(normalizedScope, this.#now());
    return {
      facts: Number(facts.count),
      activeFacts: Number(active.count),
      slots: Number(slots.count),
    };
  }

  /** 缓冲攒够阈值就落一次盘。 */
  async #maybeFlush() {
    if (this.#pending.length >= this.#flushThreshold) await this.#flush();
  }

  /**
   * 把缓冲写进库：整批一个事务，失败就整批回滚并把操作放回缓冲头部，
   * 保证「要么全成、要么一条不丢」。全程同步调用，中途不会让别的写插进来。
   */
  async #flush() {
    if (!this.#db || this.#pending.length === 0) return;
    // 先把当前缓冲摘走：flush 期间新来的写会落进新数组，不会被这一轮吞掉。
    const batch = this.#pending;
    this.#pending = [];
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const operation of batch) {
        if (operation.type === 'fact') this.#writeFact(operation.fact);
        else this.#writeSlot(operation.slot);
      }
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      this.#pending = batch.concat(this.#pending);
      throw error;
    }
  }

  /** 写一条事实：先给同三元组的当前事实封口，再插入新行。 */
  #writeFact(fact) {
    // Zep 语义：旧事实不删，valid_to 封在「新事实生效的时刻」，superseded_by 记下被谁取代，
    // 历史仍然可审计；召回只取 valid_to IS NULL，所以旧事实自然不再被检索到。
    this.#db.prepare('UPDATE facts SET valid_to = ?, superseded_by = ? '
      + 'WHERE scope = ? AND subject = ? AND predicate = ? AND valid_to IS NULL')
      .run(fact.validFrom, fact.id, fact.scope, fact.subject, fact.predicate);
    this.#db.prepare('INSERT INTO facts(id, scope, subject, predicate, object, valid_from, valid_to, '
      + 'superseded_by, source_message_id, confidence) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(fact.id, fact.scope, fact.subject, fact.predicate, fact.object, fact.validFrom,
        null, null, fact.sourceMessageId, fact.confidence);
  }

  /** 写一个槽位：冲突时原地覆盖值、更新时间与过期时间。 */
  #writeSlot(slot) {
    this.#db.prepare('INSERT INTO slots(scope, name, value, updated_at, expires_at) VALUES (?,?,?,?,?) '
      + 'ON CONFLICT(scope, name) DO UPDATE SET value = excluded.value, '
      + 'updated_at = excluded.updated_at, expires_at = excluded.expires_at')
      .run(slot.scope, slot.name, slot.value, slot.updatedAt, slot.expiresAt);
  }
}

/**
 * A memory store that holds no handle between operations.
 *
 * The plain `MemoryStore` keeps one SQLite connection open, which is right for a
 * long-lived process but wrong for a channel that must be able to delete an
 * account directory: on Windows an open handle makes the unlink fail with
 * EBUSY, and "remove this bot" has to keep working. This wrapper opens, works,
 * and closes again for every call.
 *
 * The cost is one open per operation, a few milliseconds on a warm file. The
 * benefit is that the database never owns a resource whose lifetime the channel
 * cannot control -- and a recalled fact is worth more than the microseconds an
 * open costs.
 *
 * Operations are serialized through one promise chain because two concurrent
 * writers would otherwise open the same file twice and interleave their
 * transactions. Reads queue behind writes, which is also what a single SQLite
 * file does anyway.
 */
export function createEphemeralMemoryStore(root, options = {}) {
  let tail = Promise.resolve();
  // Every operation runs strictly after the previous one, whatever it returned.
  const run = (operation) => {
    const task = tail.catch(() => undefined).then(async () => {
      const store = new MemoryStore(root, options);
      try {
        await store.ready();
        return await operation(store);
      } finally {
        // Closing flushes the buffer; a failure there must not mask the result,
        // but it must not be silently swallowed either.
        await store.close().catch((error) => options.logger?.warn?.(
          '[dsh-im] unable to close the memory database:', error,
        ));
      }
    });
    tail = task;
    return task;
  };
  return Object.freeze({
    root,
    now: () => (options.now ?? Date.now)(),
    remember: (entry) => run((store) => store.remember(entry)),
    recall: (query) => run((store) => store.recall(query)),
    slots: (scope) => run((store) => store.slots(scope)),
    setSlot: (scope, name, value, slotOptions) => run((store) => store.setSlot(scope, name, value, slotOptions)),
    forget: (scope, factId) => run((store) => store.forget(scope, factId)),
    stats: (scope) => run((store) => store.stats(scope)),
    // Nothing is held, so closing only drains the queue -- which is exactly what
    // a caller waiting before it deletes the directory needs.
    close: () => run(async () => undefined),
  });
}
