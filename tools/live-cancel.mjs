/* 取消链路的真跑验收（S6.1 + S6.3）。运行：node tools/live-cancel.mjs
 *
 * 这不是单测：它 spawn 真正的 sidecar 二进制，喂 JSON-RPC，起一个慢速大文件服务，
 * 在下载途中写 `_cancel/<id>.flag`，断言「2 秒内停手、只带回已收到的部分、标志被删」。
 * 同一个脚本顺带跑 S6.3 的三条回归（改分块读最怕把这三样弄坏）：
 *   · 二进制响应字节不变（512 KiB 随机字节，SHA-256 对得上）
 *   · 784 KiB 上传体 SHA-256 一致（等价于 verify-multipart 里那支 wav）
 *   · SSE 11 个事件完整、不标 truncated
 *   · 超时仍然是超时（不是被分块读吞成空 body）
 *
 * 前置：先编出二进制（需联网拉 crate；SDK 已 vendor，不需要任何 patch 参数）：
 *     cd backend && cargo build --release
 *
 * 用法：
 *     node tools/live-cancel.mjs                 # 默认 50 MB
 *     MB=8 node tools/live-cancel.mjs            # 想快一点
 *     BIN=/abs/path/to/sidecar node tools/live-cancel.mjs
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MB = Number(process.env.MB || 50);
const TOTAL = MB * 1024 * 1024;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/* S6.3 的回归素材：固定随机字节，跑完对哈希 */
const BIN_BODY = randomBytes(512 * 1024);
const BIN_SHA = sha256(BIN_BODY);
const UPLOAD = randomBytes(784 * 1024);          // 与那支 784 KB wav 同量级
const UPLOAD_SHA = sha256(UPLOAD);
const SSE_EVENTS = 11;

function findBin() {
  if (process.env.BIN) return process.env.BIN;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const name = 'dbx-plugin-apifox' + exe;
  /* 取最新编出来的那个：debug 刚编、release 还停在旧版本时，别拿旧产物测新代码 */
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

/* ---------- 测试服务 ---------- */
let served = 0;          // 本次连接已写出的字节数
let closedEarly = null;  // 服务端看到的「对端提前断开」时的字节数
const CHUNK = 32 * 1024;
const GAP = 12;          // ms：50 MB 需要 ~19 秒，足够在中途取消

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/small') {
    const body = Buffer.from('{"ok":true,"note":"chunked read must not change the normal path"}');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  if (url.pathname === '/bin') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': BIN_BODY.length });
    res.end(BIN_BODY);
    return;
  }
  if (url.pathname === '/echo') {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const all = Buffer.concat(parts);
      const out = Buffer.from(JSON.stringify({ sha: sha256(all), len: all.length }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': out.length });
      res.end(out);
    });
    return;
  }
  if (url.pathname === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    let i = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (i >= SSE_EVENTS) { res.end(); return; }
      res.write(`data: {"i":${i}}\n\n`);
      i++;
      setTimeout(tick, 50);
    };
    tick();
    return;
  }
  if (url.pathname === '/hang') {
    /* 头部先发出去、body 一直不写：验「读超时还是超时」 */
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.flushHeaders();
    return;
  }
  served = 0;
  closedEarly = null;
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': TOTAL });
  res.on('close', () => { if (served < TOTAL) closedEarly = served; });
  const buf = Buffer.alloc(CHUNK, 0x5a);
  const tick = () => {
    if (res.writableEnded || res.destroyed) return;
    if (served >= TOTAL) { res.end(); return; }
    const n = Math.min(CHUNK, TOTAL - served);
    served += n;
    res.write(buf.subarray(0, n));
    setTimeout(tick, GAP);
  };
  tick();
});

/* ---------- sidecar 客户端（JSON Lines） ---------- */
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
  function call(method, params, timeoutMs = 120_000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(method + ' 超时')); }, timeoutMs);
      waiters.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
    });
  }
  return { child, call };
}

/* ---------- 主流程 ---------- */
const tmpBase = path.join(os.tmpdir(), 'apifox-cancel-' + process.pid);
const cancelDir = path.join(tmpBase, '_cancel');
const cancelPath = path.join(cancelDir, 'q-live-1.flag');
rmSync(tmpBase, { recursive: true, force: true });
mkdirSync(cancelDir, { recursive: true });

let pass = 0;
const ok = (name) => { pass++; console.log('  ok  ' + name); };

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const side = startSidecar();

try {
  const init = await side.call('plugin/initialize', { host: { protocolVersions: [1] } });
  assert.ok(init.result, '握手失败：' + JSON.stringify(init.error));
  ok('sidecar 握手成功（' + path.basename(BIN) + '）');

  /* 对照：普通路径要能完整读回（分块读不许把正常响应弄坏） */
  const small = await side.call('http/request', { method: 'GET', url: base + '/small', cancelPath: path.join(cancelDir, 'never.flag') });
  assert.equal(small.result.status, 200);
  assert.match(small.result.body, /chunked read must not change/);
  assert.equal(small.result.cancelled, false);
  assert.equal(small.result.truncated, false);
  ok('未取消的请求完整返回，cancelled=false');

  /* 大文件：1.2 秒后写标志，看多久停 */
  const t0 = Date.now();
  const pending = side.call('http/request', { method: 'GET', url: base + '/big', cancelPath, timeoutMs: 120000 });
  await new Promise((r) => setTimeout(r, 1200));
  writeFileSync(cancelPath, String(Date.now()));
  const big = await pending;
  const elapsed = Date.now() - t0;
  const r = big.result;
  assert.ok(r, '大请求返回错误：' + JSON.stringify(big.error));
  assert.equal(r.cancelled, true, '没有识别到取消标志');
  assert.ok(r.size < TOTAL, '读了整包：' + r.size);
  assert.equal(r.truncated, true);
  ok(`取消被后端接住：读到 ${(r.size / 1048576).toFixed(2)} MB 后停手（总耗时 ${elapsed} ms）`);

  assert.ok(elapsed < 2000 + 1200, `停得太慢：${elapsed} ms（写标志后应在 2 秒内）`);
  ok('写标志后 2 秒内断开');

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!existsSync(cancelPath), '标志文件还在，后端没兜底清理');
  ok('后端在请求结束时删掉了标志文件');

  assert.ok(closedEarly != null && closedEarly < TOTAL, '服务端没看到提前断开（可能读完了整包）');
  ok('服务端观测到对端提前断开（' + (closedEarly / 1048576).toFixed(2) + ' MB）');

  /* 残留标志清理：上一轮停止写的文件不该让下一次请求刚发车就取消 */
  writeFileSync(cancelPath, 'stale');
  const again = await side.call('http/request', { method: 'GET', url: base + '/small', cancelPath });
  assert.equal(again.result.cancelled, false, '残留标志把新请求取消了');
  assert.match(again.result.body, /chunked read/);
  ok('发车前清掉残留标志，新请求不受影响');

  /* ---------- S6.3 回归：分块读不许弄坏这三样 ---------- */

  const bin = await side.call('http/request', { method: 'GET', url: base + '/bin' });
  assert.ok(bin.result, '二进制响应失败：' + JSON.stringify(bin.error));
  assert.equal(bin.result.size, BIN_BODY.length, 'size 与源不一致');
  assert.equal(bin.result.isBase64, true, 'image/* 应当走 base64');
  assert.equal(sha256(Buffer.from(bin.result.body, 'base64')), BIN_SHA, '二进制字节被改坏了');
  ok('512 KiB 二进制响应逐字节一致（SHA-256 对得上）');

  const echo = await side.call('http/request', {
    method: 'POST', url: base + '/echo',
    headers: { 'Content-Type': 'application/octet-stream' },
    bodyBase64: UPLOAD.toString('base64'), bodyType: 'text',
  });
  assert.ok(echo.result, '上传失败：' + JSON.stringify(echo.error));
  const echoed = JSON.parse(echo.result.body);
  assert.equal(echoed.len, UPLOAD.length, '服务端收到的长度不对');
  assert.equal(echoed.sha, UPLOAD_SHA, '上传体被改坏了');
  ok('784 KiB 上传体 SHA-256 一致（等价于那支 wav 的验收）');

  const sse = await side.call('http/request', {
    method: 'GET', url: base + '/sse',
    headers: { Accept: 'text/event-stream' }, sseMs: 4000,
  });
  assert.ok(sse.result, 'SSE 失败：' + JSON.stringify(sse.error));
  assert.equal(sse.result.sse, true);
  assert.equal((sse.result.body.match(/^data: /gm) || []).length, SSE_EVENTS, 'SSE 事件数不对');
  assert.equal(sse.result.sseTruncated, false, '正常收尾的 SSE 不该标 truncated');
  ok(`SSE ${SSE_EVENTS} 个事件完整，未被标成截断`);

  const tHang = Date.now();
  const hang = await side.call('http/request', { method: 'GET', url: base + '/hang', timeoutMs: 800 });
  const hangMs = Date.now() - tHang;
  assert.ok(hang.error, '超时请求居然成功了');
  assert.match(String(hang.error.message || ''), /read body|send|timed out|timeout/i, String(hang.error.message));
  assert.ok(hangMs < 3000, '超时生效太慢：' + hangMs + ' ms');
  ok(`超时仍然报错（${hangMs} ms，没被分块读吞成空响应）`);
} finally {
  try { side.child.kill(); } catch { /* ignore */ }
  await new Promise((r) => server.close(r));
  rmSync(tmpBase, { recursive: true, force: true });
}

console.log('\n' + pass + ' 项通过');
