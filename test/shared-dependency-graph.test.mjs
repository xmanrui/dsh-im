import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// M2 判据：shared 的依赖图必须可复算，且**边数不能是 0**。
//
// 为什么专门钉「边数非 0」：r18 实测踩到 Windows 路径分隔符坑 ——
// readdir 拼出 D:/...，path.resolve 返回 D:\\...，两者进同一个 Set 永远不相等，
// 于是边数算成 0、图是空的、结论是「无环」。那个结论看起来完美，实际什么都没测。
// 这类失败不会抛异常，只会安静地给出一个漂亮数字 ⇒ 必须有判据盯着分母。
const SHARED = resolve(import.meta.dirname, '../src/channels/shared');

/** 归一化路径：Windows 的 \\ 与 / 必须统一，否则 Set 比较恒为 false。 */
const norm = (value) => value.replace(/\\/g, '/');

async function collectFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = norm(resolve(dir, entry.name));
    if (entry.isDirectory()) { await collectFiles(path, out); continue; }
    if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

/** 建文件级依赖图（只收相对 import 且目标在本树内）。返回 { files, edges }。 */
async function buildGraph() {
  const files = (await collectFiles(SHARED)).sort();
  const set = new Set(files);
  const edges = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/from\s+['\"](\.[^'\"]+)['\"]/);
      if (!m || !m[1].startsWith('.')) continue;
      const target = norm(resolve(dirname(file), m[1]));
      if (set.has(target)) edges.push([file, target]);
    }
  }
  return { files, edges };
}

/** Tarjan SCC，返回含 >=2 节点的分量（即真实存在的环）。 */
function findCycles(nodes, edges) {
  const adj = new Map(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) adj.get(from)?.push(to);
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const sccs = [];
  const visit = (node) => {
    idx.set(node, index); low.set(node, index); index += 1;
    stack.push(node); onStack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (!idx.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), idx.get(next)));
    }
    if (low.get(node) === idx.get(node)) {
      const component = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== node);
      if (component.length >= 2) sccs.push(component);
    }
  };
  for (const node of nodes) if (!idx.has(node)) visit(node);
  return sccs;
}

test('the shared dependency graph is non-empty (guards against the empty-graph trap)', async () => {
  const { files, edges } = await buildGraph();
  assert.ok(files.length >= 100, 'expected at least 100 files, got ' + files.length);
  // 这条是核心：边数为 0 说明路径没归一化，图是空的，后面所有「无环」结论都无效。
  assert.ok(edges.length >= 100, 'edge count must be non-zero and substantial, got ' + edges.length);
  // 平均每个文件至少 1 条出边，否则说明解析漏了（本树实测 200/135 ≈ 1.48）。
  assert.ok(edges.length / files.length > 0.8, 'edge/file ratio too low: ' + (edges.length / files.length).toFixed(2));
});

test('path normalization keeps Windows separators out of the graph', async () => {
  const { files, edges } = await buildGraph();
  assert.ok(files.every((f) => !f.includes('\\')), 'file paths must be slash-normalized');
  assert.ok(edges.every(([a, b]) => !a.includes('\\') && !b.includes('\\')), 'edge endpoints must be slash-normalized');
});

test('shared is currently acyclic at file level (baseline recorded, not a hard requirement)', async () => {
  // 注意口径：这是**文件级**图。r17 报的「7 域大 SCC」是**域级**聚合图，两者不矛盾 ——
  // 文件之间没有环，把文件折叠成域之后域之间互相引用，那是目录耦合不是模块死锁。
  // 所以这里断言的是「文件级无环」这个已被实测确认的事实，并把它当基线：
  // 一旦将来引入真环，这条会红，提醒先看是不是新增了循环依赖。
  const { files, edges } = await buildGraph();
  const cycles = findCycles(files, edges);
  assert.deepEqual(cycles.map((c) => c.length), [], 'file-level cycles appeared: ' + cycles.map((c) => c.map((f) => f.split('/').pop()).join('->')).join(' | '));
});

test('dynamic import usage is counted so the graph is not silently incomplete', async () => {
  // 动态 import() 的运行时机不确定，不计入环；但如果数量很多，说明图覆盖不全，
  // 结论要打折扣。本树实测 1 个文件含动态 import。
  const { files } = await buildGraph();
  let dynamic = 0;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (/\bimport\s*\(/.test(text)) dynamic += 1;
  }
  assert.ok(dynamic <= 5, 'dynamic import files grew to ' + dynamic + '; static graph no longer representative');
});