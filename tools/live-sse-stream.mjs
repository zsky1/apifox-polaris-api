/* 订阅式 SSE 的真跑验收（S6.4）。运行：
 *     DS_KEY=sk-... node tools/live-sse-stream.mjs
 *
 * 它 spawn 真正的 sidecar，用 JSON-RPC 发一条真实请求到 DeepSeek（最便宜的
 * deepseek-chat，实际路由到 deepseek-flash），在 stdout 上收插件的
 * `apifox/http/stream` 事件通知，断言：
 *   1. 事件是「陆续」到的，不是攒完一次性吐出来；
 *   2. 每一块都能拼回去，且包含 [DONE]；
 *   3. RPC 返回值不带 body（streamed=true），所以流多长都不会撞 8 MiB 上限。
 *
 * 密钥只从环境变量读，绝不写进仓库。
 *
 * 前置：cd backend && cargo build（或用 BIN= 指定产物）。
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.DS_KEY || '';
if (!KEY) {
  console.error('缺少 DS_KEY：DS_KEY=sk-... node tools/live-sse-stream.mjs');
  process.exit(2);
}

function findBin() {
  if (process.env.BIN) return process.env.BIN;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const name = 'dbx-plugin-apifox' + exe;
  /* 两个目录都有时取**最新**的那个：debug 刚编完、release 还是上周的产物，
   * 只按目录顺序挑会拿旧二进制去测新代码，然后一头雾水。 */
  const hits = [
    path.join(root, 'backend/target/release', name),
    path.join(root, 'backend/target/debug', name),
  ].filter((p) => existsSync(p)).map((p) => ({ p, t: statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}
const BIN = findBin();
if (!BIN) { console.error('找不到 sidecar 二进制，先 cargo build'); process.exit(2); }

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + ' — ' + (e && e.message)); fail++; }
}

/* ---------- sidecar 客户端：区分「响应」与「事件」 ---------- */
const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
let onEvent = null;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (s) => {
  buf += s;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method) { if (onEvent) onEvent(msg); continue; }   // 通知（无 id）
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

/* ---------- 开始 ---------- */
const sid = 'live' + Date.now().toString(36);
const chunks = [];
const arrivals = [];
let openAt = null, openStatus = 0, doneAt = null, doneEvent = null, firstAt = null;

onEvent = (m) => {
  if (m.method !== 'apifox/http/stream') return;
  const p = m.params || {};
  if (p.requestId !== sid) return;
  const at = Date.now() - t0;
  if (p.phase === 'open') { openAt = at; openStatus = p.status; return; }
  if (p.done) { doneAt = at; doneEvent = p; return; }
  if (firstAt == null) firstAt = at;
  chunks.push(p.chunk || '');
  arrivals.push(at);
};

const t0 = Date.now();
const r = await call('http/request', {
  method: 'POST',
  url: 'https://api.deepseek.com/chat/completions',
  headers: {
    Authorization: 'Bearer ' + KEY,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '从 1 数到 30，用逗号分隔，不要别的字' }],
    stream: true,
    max_tokens: 160,
  }),
  bodyType: 'json',
  timeoutMs: 60_000,
  stream: true,
  streamRequestId: sid,
});
const totalMs = Date.now() - t0;

const body = chunks.join('');
const bytes = Buffer.byteLength(body, 'utf8');
const span = arrivals.length ? Math.max(...arrivals) - Math.min(...arrivals) : 0;

console.log(`\n  模型 deepseek-chat · 总 ${totalMs}ms · 事件 ${chunks.length} 块 · ${bytes} 字节`);
console.log(`  open ${openAt}ms(status ${openStatus}) · 首块 ${firstAt}ms · done ${doneAt}ms · 块间跨度 ${span}ms\n`);

ok('RPC 正常返回，且标记 streamed', () => {
  assert(!r.error, r.error && r.error.message);
  assert.equal(r.result.streamed, true, 'result.streamed 应为 true');
  assert.equal(r.result.status, 200, 'status 应为 200');
});
ok('返回值不带 body（大流也不会撞 8 MiB 上限）', () => {
  assert.equal(r.result.body, '', 'streamed 时 body 必须为空');
  assert(r.result.size > 0, 'size 应大于 0');
});
ok('先收到 open，再收到正文块', () => {
  assert(openAt != null, '缺少 open 事件');
  assert(chunks.length > 0, '一块正文都没收到');
  assert(openAt <= firstAt, 'open 应早于首块');
});
ok('事件是陆续到达的，不是攒完一次吐出', () => {
  assert(chunks.length >= 5, `只收到 ${chunks.length} 块，太少`);
  assert(span >= 80, `块间跨度只有 ${span}ms，像是攒完一次性发的`);
  assert(firstAt < totalMs * 0.8, `首块 ${firstAt}ms / 总 ${totalMs}ms，太晚`);
});
ok('拼回去是完整的 SSE：有 data: 与 [DONE]', () => {
  assert(body.includes('data:'), '正文里没有 data: 行');
  assert(body.includes('[DONE]'), '正文里没有 [DONE]');
});
ok('done 事件与返回值对得上', () => {
  assert(doneEvent, '缺少 done 事件');
  assert.equal(doneEvent.status, 200);
  assert.equal(doneEvent.size, bytes, `done.size ${doneEvent.size} ≠ 实际 ${bytes}`);
  assert.equal(doneEvent.truncated, false, '不应被截断');
});
ok('内容确实是模型吐的字', () => {
  assert(/1/.test(body) && /2/.test(body), '正文里应有数字');
  assert(body.includes('"content"'), '正文里应有 content 字段');
});

child.kill();
console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
process.exit(fail ? 1 : 0);
