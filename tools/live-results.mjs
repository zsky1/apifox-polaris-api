/* 结果文件回收的真跑验收（0.9.4）。
 *
 * 这不是单测：它 spawn 真正的 sidecar 二进制，连续发 `http/saveResult`，
 * 然后数磁盘上还剩几个 —— 回收逻辑在 Rust 里，靠读代码看不出对不对。
 *
 * 验五条：
 *   1. 同一个接口存 15 次，目录里只留最近 10 个（与 `_history` 的 MAX_LINES 对齐）；
 *   2. 留下的是最近的那批（时间戳最大的 10 个），最新那一条一定在；
 *   3. 两个 .http 里的同名接口（name 相同、sourceFile 不同）互不挤占；
 *   4. 老文件（0.9.3 写的、没有 interfaceId）照样进组，会被正常淘汰；
 *   5. maxKeep=0 时不回收（留个开关，将来要调口径不用改二进制）。
 *
 * 前置：cd backend && cargo build --release
 * 用法：node tools/live-results.mjs     （BIN= 可指定二进制）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function findBin() {
  if (process.env.BIN) return process.env.BIN;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const name = 'dbx-plugin-apifox' + exe;
  const hits = [
    path.join(root, 'backend/target/release', name),
    path.join(root, 'backend/target/debug', name),
  ].filter((p) => existsSync(p)).map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

const BIN = findBin();
if (!BIN) {
  console.error('找不到 sidecar 二进制。先在 backend/ 里 cargo build，或用 BIN= 指定。');
  process.exit(2);
}

/* ---------- sidecar 客户端 ---------- */
function startSidecar() {
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s) => {
    buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  let nextId = 1;
  function call(method, params, timeoutMs = 60_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(method + ' 超时')); }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }
  return { child, call, stop() { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} } };
}

/* ---------- 工具 ---------- */
const TMP = mkdtempSync(path.join(os.tmpdir(), 'apifox-results-'));
const jsonFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const entryOf = (name, sourceFile) => ({
  request: { name, method: 'POST', url: 'https://example.test/x', headers: {}, body: '', bodyType: 'none', sourceFile },
  response: { status: 200, ok: true, timeMs: 1, size: 2, text: '{}', headers: {} },
});

let pass = 0, fail = 0;
function check(cond, msg, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.error('  ✗ ' + msg + (extra ? '  ' + JSON.stringify(extra) : ''));
}

const side = startSidecar();
try {
  /* 1 + 2：同一接口 15 次，留 10 且是最近的 */
  const d1 = path.join(TMP, 'same-request');
  const saved = [];
  for (let i = 0; i < 15; i++) {
    const r = await side.call('http/saveResult', { resultsDir: d1, entry: entryOf('元数据接口', 'demo.http') });
    assert.equal(r.error, undefined, 'saveResult 报错：' + JSON.stringify(r.error));
    saved.push(r.result.path);
  }
  let files = jsonFiles(d1);
  check(files.length === 10, '同一接口存 15 次后应只剩 10 个', { got: files.length });
  const keptPaths = files.map((f) => path.join(d1, f));
  for (const p of saved.slice(5)) check(keptPaths.includes(p), '最近 10 次必须留下：' + path.basename(p));
  for (const p of saved.slice(0, 5)) check(!keptPaths.includes(p), '最早的 5 个必须删掉：' + path.basename(p));
  const lastPruned = await side.call('http/saveResult', { resultsDir: d1, entry: entryOf('元数据接口', 'demo.http') });
  check(lastPruned.result.pruned === 1, '稳定态下每存一次只删一个', { pruned: lastPruned.result.pruned });

  /* 3：同名不同文件互不挤占。
   * a.http 存 12 次（超阈值 2 个），b.http 只存 3 次 —— 若把两个文件里的同名接口
   * 混成一组，被删的就是 b 的那 3 个（时间最早）。所以这里必须各算各的。 */
  const d2 = path.join(TMP, 'two-files');
  for (let i = 0; i < 12; i++) {
    await side.call('http/saveResult', { resultsDir: d2, entry: entryOf('元数据接口', 'a.http') });
  }
  for (let i = 0; i < 3; i++) {
    await side.call('http/saveResult', { resultsDir: d2, entry: entryOf('元数据接口', 'b.http') });
  }
  files = jsonFiles(d2);
  check(files.length === 13, '两个文件里的同名接口各算各的组', { got: files.length });
  const srcs = files.map((f) => JSON.parse(readFileSync(path.join(d2, f), 'utf8')).request.sourceFile);
  check(srcs.filter((s) => s === 'a.http').length === 10, 'a.http 收敛到 10 条');
  check(srcs.filter((s) => s === 'b.http').length === 3, 'b.http 的 3 条一条都不能被挤掉');

  /* 4：老文件（没有 interfaceId、没有 response 也可）照样进组并被淘汰 */
  const d3 = path.join(TMP, 'legacy');
  const legacy = path.join(d3, '1600000000000-000001-元数据接口.json');
  rmSync(d3, { recursive: true, force: true });
  const mkdirp = (await side.call('http/saveResult', { resultsDir: d3, entry: entryOf('占位', 'demo.http') }));
  assert.ok(mkdirp.result, '目录没建出来');
  writeFileSync(legacy, JSON.stringify({
    id: '1600000000000-000001', savedAt: 1600000000000,
    request: { name: '元数据接口', method: 'POST', url: 'https://old.test/x', sourceFile: 'demo.http' },
    response: { status: 200, ok: true },
  }));
  rmSync(path.join(d3, path.basename(mkdirp.result.path)), { force: true });
  for (let i = 0; i < 10; i++) {
    await side.call('http/saveResult', { resultsDir: d3, entry: entryOf('元数据接口', 'demo.http') });
  }
  files = jsonFiles(d3);
  check(files.length === 10, '含老文件一共 11 个时应收敛到 10', { got: files.length });
  check(!existsSync(legacy), '时间最早的老文件被删掉了');

  /* 5：maxKeep=0 不回收 */
  const d4 = path.join(TMP, 'no-prune');
  for (let i = 0; i < 13; i++) {
    await side.call('http/saveResult', { resultsDir: d4, entry: entryOf('不回收', 'demo.http'), maxKeep: 0 });
  }
  files = jsonFiles(d4);
  check(files.length === 13, 'maxKeep=0 时一个都不删', { got: files.length });

  /* 6：历史里还留着的旧记录，点「详情」时文件已被回收 —— 要给一句能看懂的话，
   * 而不是笼统的「读取结果失败」。前端靠 message 里的「已回收」走黄色提示。 */
  const gone = path.join(d1, '1600000000000-000000-早就没了.json');
  const miss = await side.call('http/getResult', { path: gone });
  check(miss.error && miss.error.code === -32004, '结果文件不存在要用专门错误码 -32004', miss.error);
  check(miss.error && /已回收/.test(miss.error.message), '错误文案要说明是被回收，不是读盘失败', miss.error);
} finally {
  side.stop();
  rmSync(TMP, { recursive: true, force: true });
}

if (fail) {
  console.error(`结果回收：${pass} 通过 / ${fail} 失败`);
  process.exit(1);
}
console.log(`结果回收：${pass} 通过 / 0 失败`);
