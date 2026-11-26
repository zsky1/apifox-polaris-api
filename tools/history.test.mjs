/* http-history.js 自测。运行：node tools/history.test.mjs
 * S4.2 只验两件事：身份先落盘、历史后落盘；身份写不进去就绝不产生 jsonl。
 * 只读夹具不用 chmod 0444 —— 测试常在 root 下跑，root 无视权限位会写出假绿；
 * 改成注入一个 write 必抛 EACCES 的宿主，语义等价且稳定。
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fsHost } from './fs-host.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tools', 'fixtures', 'history-v1');
const H = require('../ui/http-file.js');
const I = require('../ui/http-identity.js');
const S = require('../ui/http-store.js');
const HIST = require('../ui/http-history.js');

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

const SAMPLE = `@baseUrl = https://api.example.com

### 登录
# @name login
POST {{baseUrl}}/login
Content-Type: application/json

{"user":"admin"}

### 取用户
GET {{baseUrl}}/users
`;

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-hist-')); }
function write(p, s) { fs.writeFileSync(p, s, 'utf8'); }
function readJsonl(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function histFiles(dir) {
  const hd = path.join(dir, '_history');
  if (!fs.existsSync(hd)) return [];
  const out = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p); else out.push(p);
    }
  })(hd);
  return out;
}
const resp = (o) => Object.assign({ status: 200, ok: true, timeMs: 42, size: 128, contentType: 'application/json' }, o || {});

/* 一次完整的"发送成功"：path/req/response，其余由 record 自己读磁盘 */
function req(over) {
  return Object.assign({ line: 5, method: 'POST', url: '{{baseUrl}}/login', name: 'login' }, over || {});
}

async function main() {
  await ok('首次记录：先补 file_id + interface_id，再写一行 jsonl，两边 id 一致', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp(), url: 'https://api.example.com/login' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, true);
    assert.match(r.fileId, /^[0-9a-z]{8}$/);
    assert.match(r.interfaceId, /^[0-9a-z]{8}$/);

    /* 文件里恰好各一行身份，且能解析回同一个 id */
    const text = fs.readFileSync(p, 'utf8');
    assert.equal((text.match(/@file_id/g) || []).length, 1);
    assert.equal((text.match(/@interface_id/g) || []).length, 1);
    const parsed = H.parseHttpFile(text);
    assert.equal(parsed.fileId, r.fileId);
    assert.equal(parsed.requests.length, 2);
    assert.equal(parsed.requests[0].interfaceId, r.interfaceId);
    assert.equal(parsed.requests[1].interfaceId, undefined);
    assert.deepEqual(parsed.warnings, []);

    /* jsonl 路径与内容 */
    assert.equal(r.historyPath, path.join(dir, '_history', 'demo', r.interfaceId + '.jsonl'));
    assert.equal(r.lines, 1);
    const rows = readJsonl(r.historyPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].interfaceId, parsed.requests[0].interfaceId);   // 验收原句
    assert.equal(rows[0].fileId, parsed.fileId);
    assert.equal(rows[0].status, 200);
    assert.equal(rows[0].method, 'POST');
    assert.equal(rows[0].url, 'https://api.example.com/login');
    assert.equal(rows[0].urlTemplate, '{{baseUrl}}/login');
    assert.equal(rows[0].fingerprint, 'POST {{baseUrl}}/login');
    assert.equal(rows[0].file, 'demo.http');
    assert.equal(rows[0].name, 'login');
    assert.ok(rows[0].at > 1600000000000);
  });

  await ok('第二次记录：身份行不重复插，jsonl 追加到同一文件', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r1 = await h.record({ path: p, req: req(), response: resp() });
    const before = fs.readFileSync(p, 'utf8');
    const r2 = await h.record({
      path: p, req: req({ interfaceId: r1.interfaceId }), response: resp({ status: 201 })
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.changed, false, '第二次不该再改文件');
    assert.equal(fs.readFileSync(p, 'utf8'), before);
    assert.equal(r2.interfaceId, r1.interfaceId);
    assert.equal(r2.lines, 2);
    const rows = readJsonl(r2.historyPath);
    assert.deepEqual(rows.map((x) => x.status), [200, 201]);
  });

  await ok('文件只读：返回 READONLY，一个 jsonl 都不产生，文件原样', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    const ro = fsHost({
      write: async () => { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; }
    });
    const store = S.createStore(ro, { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'READONLY');
    assert.deepEqual(histFiles(dir), []);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  await ok('写入冲突：重读后重试，第二次成功，且只产生一条历史', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const base = fsHost();
    let stats = 0;
    const tricky = fsHost({
      stat: async (q) => {
        stats++;
        if (stats === 2) {          /* readDoc 之后、writeText 比对之前：把文件改脏 */
          const st = await fsp.stat(q);
          const t = new Date(st.mtimeMs + 5000);
          await fsp.utimes(q, t, t);
        }
        return base.stat(q);
      }
    });
    const store = S.createStore(tricky, { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp() });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, true);
    assert.ok(stats >= 3, '应当发生过重试');
    assert.equal(readJsonl(r.historyPath).length, 1);
    /* 重试后写进去的身份与历史仍然对得上 */
    const parsed = H.parseHttpFile(fs.readFileSync(p, 'utf8'));
    assert.equal(parsed.requests[0].interfaceId, r.interfaceId);
    assert.equal(readJsonl(r.historyPath)[0].interfaceId, r.interfaceId);
  });

  await ok('没有绑定文件：NOT_FILE，不碰磁盘', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ req: req(), response: resp() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NOT_FILE');
    assert.deepEqual(histFiles(dir), []);
  });

  await ok('段找不到：NO_SEGMENT，不写历史也不改文件', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: { line: 3, method: 'DELETE', url: 'x' }, response: resp() });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'NO_SEGMENT');
    assert.deepEqual(histFiles(dir), []);
    assert.equal(fs.readFileSync(p, 'utf8'), before);
  });

  await ok('段里已有别的 id：历史记旧 id，文件不被覆盖', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, `### 甲\n# @interface_id keep0001\nGET https://a/1\n`);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: { line: 3, method: 'GET', url: 'https://a/1' }, response: resp() });
    assert.equal(r.ok, true);
    assert.equal(r.interfaceId, 'keep0001');
    const text = fs.readFileSync(p, 'utf8');
    assert.equal((text.match(/@interface_id/g) || []).length, 1);
    assert.match(text, /@interface_id keep0001/);
    assert.equal(readJsonl(r.historyPath)[0].interfaceId, 'keep0001');
  });

  await ok('历史按 collection 分目录，中文名与空格原样保留', async () => {
    const dir = mkdir();
    const p = path.join(dir, '示例 · 宠物店.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: req(), response: resp() });
    assert.equal(r.ok, true);
    assert.equal(r.historyPath, path.join(dir, '_history', '示例 · 宠物店', r.interfaceId + '.jsonl'));
    assert.equal(readJsonl(r.historyPath).length, 1);
  });

  await ok('时间戳可注入，缺省时用当前时间', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({ path: p, req: req(), response: resp(), now: 1700000000123 });
    assert.equal(readJsonl(r.historyPath)[0].at, 1700000000123);
    const r2 = await h.record({ path: p, req: req({ interfaceId: r.interfaceId }), response: resp() });
    const rows = readJsonl(r2.historyPath);
    assert.ok(rows[1].at > 1700000000123);
  });

  /* ================= S4.3：轮转 / 读取 / 二进制外置 / .gitignore ================= */

  await ok('轮转：连发 12 次只剩 10 行，且首条是第 3 次（最旧的被丢掉）', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const t0 = 1700000000000;
    let last = null;
    for (let i = 0; i < 12; i++) {
      last = await h.record({ path: p, req: req(), response: resp({ status: 200 + i }), now: t0 + i * 1000 });
      assert.equal(last.ok, true, JSON.stringify(last));
      assert.equal(last.lines, Math.min(i + 1, 10), '第 ' + (i + 1) + ' 次写完应是 ' + Math.min(i + 1, 10) + ' 行');
      assert.equal(last.rotated, i >= 10 ? 1 : 0);
    }
    const rows = readJsonl(last.historyPath);
    assert.equal(rows.length, 10);
    assert.equal(rows[0].at, t0 + 2000);            /* 第 3 次的 at —— 验收原句 */
    assert.equal(rows[0].status, 202);
    assert.equal(rows[9].at, t0 + 11000);
    assert.equal(rows[9].status, 211);
  });

  await ok('轮转保留 CRLF：原文件是 CRLF，裁完仍是 CRLF，不掺裸 LF', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'crlf.jsonl');
    const store = S.createStore(fsHost(), { dir });
    const lines = [];
    for (let i = 0; i < 12; i++) lines.push(JSON.stringify({ at: i, status: 200 }));
    write(p, lines.join('\r\n') + '\r\n');

    const r = await HIST.rotateFile(store, p, 10);
    assert.equal(r.ok, true);
    assert.equal(r.dropped, 2);
    assert.equal(r.lines, 10);
    const text = fs.readFileSync(p, 'utf8');
    assert.equal(text.split('\r\n').filter(Boolean).length, 10);
    assert.equal((text.match(/\n/g) || []).length, 10, '10 个换行里每个都该属于 CRLF');
    assert.equal((text.match(/(?<!\r)\n/g) || []).length, 0, '不该有裸 LF');
    assert.equal(readJsonl(p)[0].at, 2);
  });

  await ok('rotateText 纯函数：不超限时原样不动，超限只留最后 N 条', async () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ at: i })).join('\n') + '\n';
    assert.deepEqual(HIST.rotateText(mk(3), 10), { text: mk(3), lines: 3, dropped: 0 });
    const r = HIST.rotateText(mk(13), 10);
    assert.equal(r.lines, 10);
    assert.equal(r.dropped, 3);
    assert.equal(JSON.parse(r.text.split('\n')[0]).at, 3);
    assert.deepEqual(HIST.rotateText(mk(13), 0).dropped, 0, 'max<=0 表示不裁');
  });

  await ok('二进制外置：2 MB 的 png 落 .bin，jsonl 一行仍 < 8 KB', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const raw = Buffer.alloc(2 * 1024 * 1024, 7);
    const b64 = raw.toString('base64');
    const r = await h.record({
      path: p, req: req(), now: 1700000005000,
      response: resp({ contentType: 'image/png', isBinary: true, size: raw.length }),
      bodyBase64: b64
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.bodyBytes, raw.length);
    assert.match(r.bodyRef, /^[0-9a-z]{8}-1700000005000\.bin$/);

    const binPath = path.join(dir, '_history', 'demo', r.bodyRef);
    assert.equal(fs.existsSync(binPath), true, '.bin 应当存在');
    assert.equal(Buffer.from(fs.readFileSync(binPath, 'utf8'), 'base64').length, raw.length);
    assert.equal(Buffer.from(fs.readFileSync(binPath, 'utf8'), 'base64')[1024], 7);

    const size = fs.statSync(r.historyPath).size;
    assert.ok(size < 8 * 1024, 'jsonl 只有引用，实际 ' + size + ' 字节');
    const row = readJsonl(r.historyPath)[0];
    assert.equal(row.bodyRef, r.bodyRef);
    assert.equal(row.bodyEncoding, 'base64');
    assert.equal(row.bodyBytes, raw.length);
    assert.equal(row.contentType, 'image/png');
    assert.equal(row.text, undefined, 'jsonl 里不能留 body 本体');
  });

  await ok('二进制判定：类型命中才外置，普通 JSON 响应不产生 .bin', async () => {
    assert.equal(HIST.isBinaryContentType('image/png'), true);
    assert.equal(HIST.isBinaryContentType('audio/mpeg'), true);
    assert.equal(HIST.isBinaryContentType('application/octet-stream'), true);
    assert.equal(HIST.isBinaryContentType('application/zip'), true);
    assert.equal(HIST.isBinaryContentType('application/x-zip-compressed; charset=x'), true);
    assert.equal(HIST.isBinaryContentType('application/json'), false);
    assert.equal(HIST.isBinaryContentType('text/plain'), false);
    assert.equal(HIST.isBinaryContentType(''), false);

    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    const r = await h.record({
      path: p, req: req(), response: resp({ text: '{"a":1}' }), bodyBase64: Buffer.from('{"a":1}').toString('base64')
    });
    assert.equal(r.ok, true);
    assert.equal(r.bodyRef, null);
    assert.equal(readJsonl(r.historyPath)[0].bodyRef, undefined);
    assert.deepEqual(histFiles(dir).filter((f) => f.endsWith('.bin')), []);
  });

  await ok('body 超上限：不落 .bin，历史照记一条并标 TOO_LARGE（上限由调用方给）', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir, maxBodyBytes: 1024 });

    const b64 = Buffer.alloc(4096, 1).toString('base64');
    const r = await h.record({
      path: p, req: req(), response: resp({ contentType: 'application/zip', isBinary: true }), bodyBase64: b64
    });
    assert.equal(r.ok, true);
    assert.equal(r.bodyRef, null);
    assert.equal(r.bodyOmitted, 'TOO_LARGE');
    assert.equal(r.bodyBytes, 4096);
    const row = readJsonl(r.historyPath)[0];
    assert.equal(row.bodyRef, undefined);
    assert.equal(row.bodyOmitted, 'TOO_LARGE');
    assert.deepEqual(histFiles(dir).filter((f) => f.endsWith('.bin')), []);
  });

  await ok('同毫秒两次二进制：.bin 不互相覆盖，各留一个序号', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const a = await h.record({
      path: p, req: req(), now: 1700000009000,
      response: resp({ contentType: 'image/gif', isBinary: true }), bodyBase64: Buffer.from('AAA').toString('base64')
    });
    const b = await h.record({
      path: p, req: req({ interfaceId: a.interfaceId }), now: 1700000009000,
      response: resp({ contentType: 'image/gif', isBinary: true }), bodyBase64: Buffer.from('BBB').toString('base64')
    });
    assert.notEqual(a.bodyRef, b.bodyRef);
    assert.match(b.bodyRef, /-1700000009000-2\.bin$/);
    const base = path.join(dir, '_history', 'demo');
    assert.equal(Buffer.from(fs.readFileSync(path.join(base, a.bodyRef), 'utf8'), 'base64').toString(), 'AAA');
    assert.equal(Buffer.from(fs.readFileSync(path.join(base, b.bodyRef), 'utf8'), 'base64').toString(), 'BBB');
  });

  await ok('读取：坏行（截断 JSON / 不是对象）跳过，其余行照常返回', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const hp = HIST.historyPathFor(dir, 'demo', 'abc12345');
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    write(hp, [
      '{"at":1,"status":200}',
      '{"at":2,"status":20',            /* 截断 */
      '[1,2,3]',                        /* 合法 JSON 但不是对象 */
      '',                               /* 空行不算坏行 */
      '{"at":3,"status":404}'
    ].join('\n') + '\n');

    const r = await HIST.read({ store, dir, collection: 'demo', interfaceId: 'abc12345' });
    assert.equal(r.ok, true);
    assert.equal(r.path, hp);
    assert.deepEqual(r.rows.map((x) => x.at), [1, 3]);
    assert.equal(r.bad, 2);
    assert.equal(r.total, 4);
  });

  await ok('读取：还没有历史时返回空数组而不是报错', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const r = await HIST.read({ store, dir, collection: 'nope', interfaceId: 'zzz' });
    assert.equal(r.ok, true);
    assert.equal(r.missing, true);
    assert.deepEqual(r.rows, []);
    assert.equal(r.bad, 0);
    const h = HIST.createHistory({ store, dir });
    const r2 = await h.read({ collection: 'nope', interfaceId: 'zzz' });
    assert.deepEqual(r2.rows, [], 'createHistory 上的 read 走同一份 store/dir');
  });

  await ok('.gitignore：没有就建（只放 _history/），有了不动，缺这行就补一行', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const gi = path.join(dir, '.gitignore');

    const a = await HIST.ensureGitignore(store, dir);
    assert.equal(a.ok, true);
    assert.equal(a.created, true);
    assert.equal(fs.readFileSync(gi, 'utf8'), '_history/\n');

    const before = fs.readFileSync(gi, 'utf8');
    const b = await HIST.ensureGitignore(store, dir);
    assert.equal(b.changed, false);
    assert.equal(fs.readFileSync(gi, 'utf8'), before);

    const dir2 = mkdir();
    write(path.join(dir2, '.gitignore'), 'node_modules/\n');
    const store2 = S.createStore(fsHost(), { dir: dir2 });
    const c = await HIST.ensureGitignore(store2, dir2);
    assert.equal(c.changed, true);
    assert.equal(fs.readFileSync(path.join(dir2, '.gitignore'), 'utf8'), 'node_modules/\n_history/\n');

    /* 末尾没换行也要接得上，不能粘成一行 */
    const dir3 = mkdir();
    write(path.join(dir3, '.gitignore'), 'dist');
    const store3 = S.createStore(fsHost(), { dir: dir3 });
    await HIST.ensureGitignore(store3, dir3);
    assert.equal(fs.readFileSync(path.join(dir3, '.gitignore'), 'utf8'), 'dist\n_history/\n');
  });

  await ok('record 之后资源目录自动带上 _history/，且只补一次', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });
    await h.record({ path: p, req: req(), response: resp() });
    const gi = path.join(dir, '.gitignore');
    assert.equal(fs.readFileSync(gi, 'utf8'), '_history/\n');
    await h.record({ path: p, req: req(), response: resp() });
    assert.equal(fs.readFileSync(gi, 'utf8'), '_history/\n');
  });


  /* ================= S4.6：身份索引与接回 ================= */

  await ok('身份索引：删掉 id 行再发，按指纹能找回旧 id 与它的条数', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r1 = await h.record({ path: p, req: req(), response: resp(), now: 1700000000001 });
    assert.equal(r1.assigned, true, '首次发送应当分配身份');
    await h.record({ path: p, req: req({ interfaceId: r1.interfaceId }), response: resp(), now: 1700000000002 });
    await h.record({ path: p, req: req({ interfaceId: r1.interfaceId }), response: resp(), now: 1700000000003 });
    assert.equal(readJsonl(r1.historyPath).length, 3);

    /* 模拟「换机器 / 手滑删了 id 行」 */
    const stripped = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*#\s*@interface_id\b/.test(l)).join('\n');
    write(p, stripped);
    const r2 = await h.record({ path: p, req: req(), response: resp(), now: 1700000000004 });
    assert.equal(r2.ok, true);
    assert.notEqual(r2.interfaceId, r1.interfaceId);
    assert.equal(r2.assigned, true);
    assert.equal(readJsonl(r2.historyPath).length, 1);

    const hit = await HIST.findByIdentity({
      store, dir, collection: 'demo', fingerprint: r2.fingerprint, excludeId: r2.interfaceId
    });
    assert.equal(hit.ok, true);
    assert.equal(hit.interfaceId, r1.interfaceId, '应当推荐旧 id');
    assert.equal(hit.hit.count, 3, '要带上旧 id 已有几条，提示条上要写出来');
    assert.equal(hit.hit.path, r1.historyPath);
  });

  await ok('接回：文件 id 换回旧的，历史并进旧文件，新文件删掉', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r1 = await h.record({ path: p, req: req(), response: resp(), now: 1700000000001 });
    await h.record({ path: p, req: req({ interfaceId: r1.interfaceId }), response: resp(), now: 1700000000002 });
    const stripped = fs.readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*#\s*@interface_id\b/.test(l)).join('\n');
    write(p, stripped);
    const r2 = await h.record({ path: p, req: req(), response: resp(), now: 1700000000003 });

    const rr = await HIST.reuse(store, {
      dir, path: p, collection: 'demo',
      req: { line: 6, method: 'POST', url: '{{baseUrl}}/login' },
      fromId: r2.interfaceId, toId: r1.interfaceId
    });
    assert.equal(rr.ok, true, JSON.stringify(rr));
    assert.equal(rr.merged, true);
    assert.equal(rr.mergedRows, 3);

    const doc = H.parseHttpFile(fs.readFileSync(p, 'utf8'));
    assert.equal(doc.requests[0].interfaceId, r1.interfaceId, '文件里的 id 必须是旧的');
    assert.equal(doc.requests.length, 2, '接回不许改变请求数');
    assert.equal((fs.readFileSync(p, 'utf8').match(/@interface_id/g) || []).length, 1);
    assert.equal(readJsonl(r1.historyPath).length, 3, '2 + 1，还是 3 条');
    assert.equal(fs.existsSync(r2.historyPath), false, '新 id 的 jsonl 应当被删掉');

    /* 合并后旧 id 还在索引里，新 id 的候选因为文件没了会被跳过 */
    const hit = await HIST.findByIdentity({ store, dir, collection: 'demo', fingerprint: r2.fingerprint, excludeId: 'zzzzzzzz' });
    assert.equal(hit.interfaceId, r1.interfaceId, '删掉文件的 id 不该再被推荐');
  });

  await ok('接回：区间为空的旧 id（没有历史文件）也能接，只是合并 0 条', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, `### 甲\n# @interface_id old00009\nGET https://a/1\n`);
    const store = S.createStore(fsHost(), { dir });
    const r = await HIST.reuse(store, {
      dir, path: p, collection: 'demo',
      req: { line: 3, method: 'GET', url: 'https://a/1' },
      fromId: 'new00009', toId: 'old00009'
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.changed, false, 'id 本来就对，不该改文件');
    assert.equal(r.merged, true, '合并空文件也算成功');
  });

  /* ================= S7.1：数据格式冻结（v1） ================= */

  await ok('格式 v1：每条记录首字段是 v=1，同时种下 _history/_meta.json', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r = await h.record({ path: p, req: req(), response: resp(), now: 1732060800000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(HIST.FORMAT_VERSION, 1);

    const raw = fs.readFileSync(r.historyPath, 'utf8');
    assert.match(raw, /^\{"v":1,/, 'v 必须是首字段：' + raw.slice(0, 40));
    const row = JSON.parse(raw.trim());
    assert.deepEqual(Object.keys(row).slice(0, 3), ['v', 'at', 'status'], '前三个键的顺序是契约');
    assert.equal(row.v, 1);

    const mp = path.join(dir, '_history', '_meta.json');
    assert.equal(mp, HIST.metaPath(dir));
    const meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
    assert.deepEqual(Object.keys(meta), ['formatVersion', 'app', 'createdAt']);
    assert.equal(meta.formatVersion, 1);
    assert.equal(meta.app, 'com.fax.apifox');
    assert.ok(!Number.isNaN(Date.parse(meta.createdAt)), 'createdAt 应是 ISO 8601');
  });

  await ok('_meta.json：二次记录一个字节都不动，已有文件绝不覆盖', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r1 = await h.record({ path: p, req: req(), response: resp(), now: 1732060800000 });
    const mp = path.join(dir, '_history', '_meta.json');
    const first = fs.readFileSync(mp, 'utf8');
    await h.record({ path: p, req: req({ interfaceId: r1.interfaceId }), response: resp(), now: 1732060860000 });
    assert.equal(fs.readFileSync(mp, 'utf8'), first, '第二次记录不该重写 _meta.json');

    /* 预置一份（模拟更早版本/别的机器写的），record 之后仍原样 */
    const dir2 = mkdir();
    const p2 = path.join(dir2, 'demo.http');
    write(p2, SAMPLE);
    fs.mkdirSync(path.join(dir2, '_history'), { recursive: true });
    const mine = '{"formatVersion":1,"app":"com.fax.apifox","createdAt":"2020-01-01T00:00:00.000Z"}\n';
    write(path.join(dir2, '_history', '_meta.json'), mine);
    const store2 = S.createStore(fsHost(), { dir: dir2 });
    await HIST.createHistory({ store: store2, dir: dir2 }).record({ path: p2, req: req(), response: resp() });
    assert.equal(fs.readFileSync(path.join(dir2, '_history', '_meta.json'), 'utf8'), mine);
  });

  await ok('_meta.json 读不懂时不覆盖：只报 META_UNREADABLE，数据还在', async () => {
    const dir = mkdir();
    fs.mkdirSync(path.join(dir, '_history'), { recursive: true });
    const broken = '{"formatVersion":2,"app":"com.fax.apifox","extra":';
    const mp = path.join(dir, '_history', '_meta.json');
    write(mp, broken);
    const store = S.createStore(fsHost(), { dir });
    const r = await HIST.ensureMeta(store, dir);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'META_UNREADABLE');
    assert.equal(fs.readFileSync(mp, 'utf8'), broken, '不许覆盖读不懂的元数据');
  });

  await ok('向后兼容：没有 v 的旧行（0.9.x）照常读，按 v1 解释', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const hp = HIST.historyPathFor(dir, 'demo', 'ping0001');
    fs.mkdirSync(path.dirname(hp), { recursive: true });
    fs.copyFileSync(path.join(FIX, 'legacy-no-v.jsonl'), hp);

    const r = await HIST.read({ store, dir, collection: 'demo', interfaceId: 'ping0001' });
    assert.equal(r.ok, true);
    assert.equal(r.bad, 0);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].v, undefined, '旧行不该被补上 v');
    assert.equal(r.rows[0].status, 200);
    assert.equal(r.formatVersion, 1, '缺 v 一律按 1 算');
    assert.equal(r.future, false);
  });

  await ok('未知字段：读取时保留，合并重写时逐字节原样（不洗键序/空白）', async () => {
    const dir = mkdir();
    const store = S.createStore(fsHost(), { dir });
    const base = path.join(dir, '_history', 'demo');
    fs.mkdirSync(base, { recursive: true });

    const unknownLine = fs.readFileSync(path.join(FIX, 'unknown-field.jsonl'), 'utf8').trim();
    write(path.join(base, 'avat0001.jsonl'), unknownLine + '\n');
    write(path.join(base, 'new00002.jsonl'),
      '{"v":1,"at":1732060990000,"status":200,"ok":true,"timeMs":9,"size":2,"method":"GET","url":"https://api.example.com/avatar","urlTemplate":"{{baseUrl}}/avatar","fingerprint":"GET {{baseUrl}}/avatar","contentType":"image/png","interfaceId":"new00002","fileId":"demo0001","file":"demo.http","name":"头像"}\n');

    const before = await HIST.read({ store, dir, collection: 'demo', interfaceId: 'avat0001' });
    assert.equal(before.rows[0].serverTiming, 'db;dur=12', '未知字段要能被读出来');

    const m = await HIST.mergeInto(store, dir, 'demo', 'new00002', 'avat0001', 10);
    assert.equal(m.ok, true, JSON.stringify(m));
    const text = fs.readFileSync(path.join(base, 'avat0001.jsonl'), 'utf8');
    assert.ok(text.includes(unknownLine), '未知字段那一行应逐字节保留');
    assert.match(text.split('\n')[0], /"serverTiming":"db;dur=12"}$/, '未知字段不许被丢掉');
    assert.equal(text.split('\n').filter(Boolean).length, 2);
  });

  await ok('更新版本：v=2 的历史只读展示（future），旧版一行都不追加', async () => {
    const dir = mkdir();
    const p = path.join(dir, 'demo.http');
    write(p, SAMPLE);
    const store = S.createStore(fsHost(), { dir });
    const h = HIST.createHistory({ store, dir });

    const r1 = await h.record({ path: p, req: req(), response: resp(), now: 1732060800000 });
    assert.equal(r1.ok, true);
    const hp = r1.historyPath;
    const v2 = fs.readFileSync(path.join(FIX, 'v2-future.jsonl'), 'utf8').trim();
    write(hp, v2 + '\n');
    const before = fs.readFileSync(hp, 'utf8');

    const rd = await HIST.read({ store, dir, collection: 'demo', interfaceId: r1.interfaceId });
    assert.equal(rd.future, true);
    assert.equal(rd.formatVersion, 2);
    assert.equal(rd.rows.length, 1, '新版本的行仍要列出来');

    const r2 = await h.record({ path: p, req: req({ interfaceId: r1.interfaceId }), response: resp(), now: 1732060900000 });
    assert.equal(r2.ok, true, '身份已就位，不该整个失败');
    assert.equal(r2.historyWritten, false);
    assert.equal(r2.historyReason, 'FUTURE_FORMAT');
    assert.equal(r2.futureFormatVersion, 2);
    assert.equal(fs.readFileSync(hp, 'utf8'), before, 'v2 文件一个字节都不许动');
  });

  console.log('\n' + pass + ' 项通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
