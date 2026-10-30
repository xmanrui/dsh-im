import { t } from '../shared/i18n.mjs';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { AirumoApi, AirumoError, validateUpdate } from './api.mjs';
import { askInWorkspaceSession } from '../shared/workspace-session.mjs';
import { HarnessReplyTracker } from '../shared/harness-client.mjs';
import {
  OUTBOUND_ARTIFACT_TOOL,
  materializeOutboundArtifact,
  releaseOutboundArtifact,
} from '../shared/semantic/artifact.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired', 'outcome_unknown']);
const terminalFailure = () => ({
  status: 'failed',
  error_code: 'EXECUTION_OUTCOME_UNKNOWN',
  content: {
    text: t("上次处理被中断，无法确认完整结果。为避免重复执行，没有自动重做；请核对聊天后重新提问。"),
    attachments: [],
  },
});

export class AirumoRuntime {
  constructor({
    config,
    token,
    harness,
    state,
    logger = console,
    api,
    checkReady,
    cancelExecution = async () => {},
    heartbeatMs = 30000,
    cancelCheckMs = 10000,
    now = Date.now,
    concurrency = 2,
  }) {
    Object.assign(this, {
      config,
      harness,
      state,
      logger,
      checkReady,
      cancelExecution,
      heartbeatMs,
      cancelCheckMs,
      now,
      concurrency,
    });
    this.api = api ?? new AirumoApi(token);
    this.status = {
      ready: false,
      connectionState: 'connecting',
      harnessReachable: false,
      messagesReceived: 0,
      messagesReplied: 0,
      error: null,
      retryable: true,
    };
    this.queue = new Map();
    this.active = new Map();
    this.sessions = new Set();
  }

  async start() {
    this.abort = new AbortController();
    this.me = await this.api.me(this.abort.signal);
    if (this.me.user_agent_id !== this.config.platformId)
      throw new AirumoError('BOT_ID_CHANGED', 400);
    await this.heartbeat();
    this.status.ready = true;
    this.status.lastConnectedAt = new Date().toISOString();
    this.pollTask = this.poll();
    this.heartbeatTask = this.heartbeatLoop();
  }

  error(error) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : 'INTERNAL_ERROR';
    this.status.error = {
      code,
      message: error?.halt
        ? t("AIRumo 已暂停或凭据已失效，请在 AIRumo 恢复机器人或重新填写 Token。")
        : t('AIRumo 连接暂未就绪（{code}），请检查网络和机器人设置。', { code }),
    };
    this.logger.warn?.(`[dsh-im:airumo] ${code}`);
    if (error?.halt) {
      this.status.ready = false;
      this.status.retryable = false;
      this.status.connectionState = 'failed';
      void this.stop();
    }
  }

  async retry(operation, signal) {
    for (let n = 0; ; n++) {
      signal.throwIfAborted();
      try {
        return await operation();
      } catch (error) {
        if (signal.aborted || !error?.retryable) throw error;
        this.error(error);
        await sleep(
          Math.max(error.retryAfterMs ?? 0, Math.min(30000, 1000 * 2 ** Math.min(n, 5))) +
            Math.random() * 250,
          undefined,
          { signal },
        );
      }
    }
  }

  async heartbeat() {
    let available = false;
    try {
      await this.harness.ensureRunning({ signal: this.abort.signal });
      const catalog = await this.harness.listModels({ signal: this.abort.signal });
      if (!catalog.groups.some((g) => g.models.length)) throw new Error('No models');
      await this.checkReady?.(this.abort.signal);
      available = true;
    } catch {
      this.status.error = {
        code: 'HARNESS_UNAVAILABLE',
        message: t("模型尚未就绪，请核对 Harness 和模型设置。"),
      };
    }
    this.status.harnessReachable = available;
    await this.api.status(
      available ? (this.active.size ? 'busy' : 'ready') : 'unavailable',
      available ? null : 'HARNESS_UNAVAILABLE',
      this.abort.signal,
    );
    this.status.connectionState = 'connected';
    this.status.lastCheckedAt = new Date().toISOString();
    if (available) this.status.error = null;
    this.drain();
  }

  async heartbeatLoop() {
    while (!this.abort.signal.aborted) {
      try {
        await sleep(this.heartbeatMs, undefined, { signal: this.abort.signal });
        await this.heartbeat();
      } catch (error) {
        if (!this.abort.signal.aborted) this.error(error);
      }
    }
  }

  async poll() {
    const signal = this.abort.signal;
    let recovered = false;
    while (!signal.aborted) {
      try {
        const updates = await this.retry(
          () => this.api.updates(this.state.consumerId(), signal),
          signal,
        );
        if (!recovered) {
          recovered = true;
          for (const entry of this.state.requests())
            if (entry.phase !== 'done') this.queue.set(entry.input.request_id, entry);
        }
        for (const raw of updates) {
          const input = validateUpdate(raw);
          const id = input.request_id;
          if (this.state.request(id) || this.queue.size >= 50) continue;
          const entry = { input, phase: 'queued', at: this.now(), attachments: [] };
          await this.state.putRequest(entry);
          this.queue.set(id, entry);
          this.status.messagesReceived++;
        }
        this.drain();
      } catch (error) {
        if (signal.aborted) break;
        this.error(error);
        // Even a malformed update must not create a tight poll loop.
        try {
          await sleep(Math.max(error.retryAfterMs ?? 0, 3000), undefined, { signal });
        } catch {
          break;
        }
      }
    }
  }

  key(input) {
    const rule = input.rule_context;
    // Group reply rules use a per-execution session_id. Keep their conversation
    // stable across requests and members, without collapsing explicit topics,
    // other rule actions, rooms or bots into the same Harness session.
    if (input.source_kind === 'message'
      && rule?.rule_kind === 'group'
      && rule.action_type === 'agent_reply'
      && typeof rule.rule_id === 'string' && rule.rule_id
      && input.session_id.startsWith(`rule:${rule.rule_id}:request:`)) {
      return JSON.stringify([this.me.user_agent_id, 'group-rule', input.room_id, rule.rule_id]);
    }
    return JSON.stringify([this.me.user_agent_id, input.session_id]);
  }

  drain() {
    if (this.abort?.signal.aborted || !this.status.harnessReachable) return;
    for (const [id, entry] of this.queue) {
      if (this.active.size >= this.concurrency) break;
      const key = this.key(entry.input);
      if (this.sessions.has(key)) continue;
      this.queue.delete(id);
      const abort = new AbortController();
      const job = { entry, abort, key, terminal: false, progressAt: 0 };
      this.active.set(id, job);
      this.sessions.add(key);
      job.task = this.run(job)
        .catch((error) => {
          if (!this.abort.signal.aborted) this.error(error);
        })
        .finally(() => {
          this.active.delete(id);
          this.sessions.delete(key);
          this.drain();
        });
    }
  }

  async save(entry, patch) {
    Object.assign(entry, patch);
    await this.state.putRequest(entry);
  }

  async stopOwned(job) {
    if (job.entry.handle) await this.cancelExecution(job.entry.handle);
    job.abort.abort();
  }

  async watch(job) {
    while (!job.abort.signal.aborted) {
      await sleep(this.cancelCheckMs, undefined, { signal: job.abort.signal });
      const remote = await this.retry(
        () => this.api.request(job.entry.input.request_id, job.abort.signal),
        job.abort.signal,
      );
      if (TERMINAL.has(remote.state) || this.now() >= job.entry.input.deadline_ts) {
        job.terminal = true;
        await this.stopOwned(job);
      }
    }
  }

  async publish(entry, signal) {
    const body = {
      idempotency_key: `result-${createHash('sha256').update(entry.input.request_id).digest('hex')}`,
      ...(entry.executionId ? { execution_id: entry.executionId } : {}),
      ...entry.result,
    };
    await this.retry(() => this.api.result(entry.input.request_id, body, signal), signal);
    await this.save(entry, {
      phase: 'done',
      input: { request_id: entry.input.request_id },
      handle: null,
    });
    this.status.messagesReplied++;
  }

  async recover(entry, signal) {
    if (!entry.handle || entry.artifactPending) return terminalFailure();
    const { sessionId, promptRpcId, baselineSeq } = entry.handle;
    const tracker = new HarnessReplyTracker({ promptRpcId, afterSeq: baselineSeq });
    // Observe only the original prompt. Never resubmit an accepted execution after reconnect.
    while (this.now() < entry.input.deadline_ts) {
      const history = await this.harness.rpc(
        'session.history',
        { sessionId, maxMessages: 500 },
        30000,
        { signal },
      );
      tracker.consumeAll(history.events ?? []);
      if (tracker.finished) {
        const returnedFiles = new Set((history.events ?? []).map((e) => e.event ?? e)
          .filter((e) => e.type === 'tool/call' && e.data?.turn === tracker.turn
            && e.data.name === OUTBOUND_ARTIFACT_TOOL)
          .map((e) => e.data.callId));
        // A crash may precede onArtifact: do not claim success with a missing file.
        if (returnedFiles.size > entry.attachments.length) return terminalFailure();
        if ((tracker.reason?.kind ?? tracker.reason) !== 'completed' || !tracker.answer)
          return terminalFailure();
        return {
          status: 'succeeded',
          content: { text: tracker.answer, attachments: entry.attachments },
        };
      }
      if (!(await this.harness.isSessionRunning(sessionId, { signal }))) return terminalFailure();
      await sleep(1000, undefined, { signal });
    }
    return terminalFailure();
  }

  async fitResult(entry, result, signal) {
    // The JSON envelope defaults to 16 KiB, independently of the 32k character limit.
    if (Buffer.byteLength(JSON.stringify(result)) > 14000) {
      if (result.content.attachments.length >= 10) throw new AirumoError('RESULT_TOO_LARGE', 413);
      const file = await this.retry(
        () =>
          this.api.upload(
            entry.input.request_id,
            {
              fileName: t("完整回复.md"),
              mediaType: 'text/markdown',
              bytes: Buffer.from(result.content.text),
            },
            signal,
          ),
        signal,
      );
      result.content = {
        text: t("回复较长，完整内容见附件。"),
        attachments: [...result.content.attachments, file],
      };
    }
    return result;
  }

  async run(job) {
    const { entry, key } = job;
    const signal = job.abort.signal;
    const id = entry.input.request_id;
    let watcher;
    const deadline = setTimeout(
      () => {
        job.terminal = true;
        void this.stopOwned(job).catch(() => job.abort.abort());
      },
      Math.max(0, entry.input.deadline_ts - this.now()),
    );
    try {
      const remote = await this.retry(() => this.api.request(id, signal), signal);
      if (TERMINAL.has(remote.state) || this.now() >= entry.input.deadline_ts) {
        await this.save(entry, { phase: 'done', input: { request_id: id } });
        return;
      }
      if (entry.result) {
        await this.publish(entry, signal);
        return;
      }
      if (!entry.executionId) {
        await this.save(entry, { phase: 'accepting' });
        const accepted = await this.retry(
          () => this.api.accept(id, this.state.consumerId(), signal),
          signal,
        );
        if (typeof accepted.execution_id !== 'string')
          throw new AirumoError('INVALID_EXECUTION', 502);
        await this.save(entry, { executionId: accepted.execution_id, phase: 'accepted' });
      }
      watcher = this.watch(job).catch(async (error) => {
        if (!signal.aborted) {
          this.error(error);
          job.terminal = !!error.terminal;
          await this.stopOwned(job);
        }
      });
      let result;
      if (entry.phase === 'executing' || entry.phase === 'dispatching') {
        result = await this.recover(entry, signal);
      } else {
        await this.save(entry, { phase: 'dispatching' });
        const u = entry.input;
        const files = (u.attachments ?? []).map((a) => ({
          name: t("AIRumo 附件"),
          load: ({ signal: s }) => this.api.download(id, a.media_id, s),
        }));
        const source = {
          sender: u.message.sender,
          session_id: u.session_id,
          room_id: u.room_id,
          source_kind: u.source_kind,
          rule_context: u.rule_context,
        };
        const text = u.message.content.body;
        if (!text.trim() && !files.length) throw new AirumoError('EMPTY_INPUT', 400);
        let artifactError;
        const { answer } = await askInWorkspaceSession({
          harness: this.harness,
          state: this.state,
          key,
          text,
          content: `${text}\n\n<airumo_source>${JSON.stringify(source)}</airumo_source>`,
          contextEnhanced: true,
          createOptions: { signal },
          existsOptions: { signal },
          askOptions: {
            signal,
            files,
            control: { owner: this, key: id },
            reasoning: false,
            onPrompt: (handle) => this.save(entry, { handle, phase: 'executing' }),
            onUpdate: async () => {
              if (this.now() - job.progressAt < 11000) return;
              job.progressAt = this.now();
              try {
                await this.api.progress(id, entry.executionId, t('正在处理…'), signal);
              } catch (error) {
                if (error.halt || error.terminal) throw error;
              }
            },
            onArtifact: async (artifact) => {
              try {
                if (entry.attachments.length >= 10) throw new AirumoError('TOO_MANY_FILES', 413);
                await this.save(entry, { artifactPending: true });
                const file = await materializeOutboundArtifact(artifact, { signal });
                const media = await this.api.upload(id, file, signal);
                entry.attachments.push(media);
                await this.save(entry, { attachments: entry.attachments, artifactPending: false });
              } catch (error) {
                artifactError = error;
                throw error;
              } finally {
                releaseOutboundArtifact(artifact);
              }
            },
          },
        });
        if (artifactError) throw artifactError;
        result = { status: 'succeeded', content: { text: answer, attachments: entry.attachments } };
      }
      await this.save(entry, {
        result: await this.fitResult(entry, result, signal),
        phase: 'result',
      });
      await this.publish(entry, signal);
    } catch (error) {
      if (entry.handle) await this.cancelExecution(entry.handle);
      if (this.abort.signal.aborted) return; // Durable handle remains available for recovery.
      if (job.terminal || error?.terminal) {
        await this.save(entry, { phase: 'done', input: { request_id: id } });
        return;
      }
      if (error?.halt) {
        this.error(error);
        return;
      }
      // Never replace a cached final result after an uncertain publication.
      if (!entry.result) {
        const failed = terminalFailure();
        if (!entry.handle)
          failed.content.text = t("本次处理未完成，请检查模型、连接或附件后重试。");
        await this.save(entry, { result: failed, phase: 'result' });
      }
      if (!signal.aborted) {
        try {
          await this.publish(entry, signal);
        } catch (publishError) {
          this.error(publishError);
        }
      }
    } finally {
      clearTimeout(deadline);
      if (signal.aborted && entry.handle) await this.cancelExecution(entry.handle);
      job.abort.abort();
      await watcher;
    }
  }

  async stop() {
    if (!this.abort || this.abort.signal.aborted) return;
    this.abort.abort();
    await Promise.allSettled([...this.active.values()].map((job) => this.stopOwned(job)));
    await Promise.allSettled([
      this.pollTask,
      this.heartbeatTask,
      ...[...this.active.values()].map((job) => job.task),
    ]);
    this.status.ready = false;
    this.status.connectionState = 'failed';
  }
}
