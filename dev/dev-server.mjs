/* dev-server.mjs — 在浏览器里手动点插件用的本地调试服务器。
 *
 *   node dev/dev-server.mjs            # 默认 8899
 *   PORT=9000 node dev/dev-server.mjs
 *
 * 做三件事：
 *   1. 静态托管 ui/，并把 dev/mock-host.js 注入 index.html 的 <head>
 *      （真实插件由 DBX 注入 window.dbxPlugin，这里用假宿主顶替）
 *   2. /__dev/invoke  —— 把插件的 invoke 落到本机真实文件系统
 *   3. /api/*         —— 几个假接口，让示例请求点下去真有响应（不用联网）
 *
 * 数据目录默认 ../dev-workspace，首次启动会种几个示例 .http。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const UI_DIR = path.join(ROOT, 'ui');
const WORK = path.resolve(process.env.WORKDIR || path.join(ROOT, '..', 'dev-workspace'));
const RESULTS = path.join(WORK, '_results');
const PORT = Number(process.env.PORT || 8899);
/* 绑定 0.0.0.0 才能被反向代理/公网隧道接到；本机 127.0.0.1:PORT 照样能开。
 * 想只在本机用，起服务时给 HOST=127.0.0.1。 */
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------- 示例数据 ---------------- */

const ENV_FILE = {
  开发: { baseUrl: 'http://127.0.0.1:' + PORT, token: 'demo-token-123', userId: 'u-42' },
  预发: { baseUrl: 'https://staging.example.com', token: 'staging-token' },
};

const DEMO_HTTP = `# @file_id demo0001  该字段在 wpa 中有意义（文件身份），一般不用改
# 本地自测集合 —— 下面每个请求都能真的点「发送」，服务由 dev-server 提供。

# 变量来自 dev-workspace/http-client.env.json 的「开发」环境（baseUrl = 本机调试服务）

### 列表（普通 JSON）
# @interface_id list0001
GET {{baseUrl}}/api/pets
Accept: application/json

### 创建一个（POST + JSON body）
# @interface_id create001
POST {{baseUrl}}/api/pets
Content-Type: application/json

{
  "name": "旺财",
  "kind": "dog",
  "tags": ["friendly", "loud"]
}

### 表单提交（body 用 form 形式）
# @interface_id form0001
POST {{baseUrl}}/api/login
Content-Type: application/x-www-form-urlencoded

user=demo&pass=secret

### 慢响应（3 秒，用来看 loading / 之后试取消）
# @interface_id slow0001
GET {{baseUrl}}/api/slow?ms=3000

### 会失败（500，用来看错误态）
# @interface_id fail0001
GET {{baseUrl}}/api/500

### 大响应（约 200 条，用来看 JSON 折叠与滚动）
# @interface_id big00001
GET {{baseUrl}}/api/big?n=200
`;

const HAND = fs.existsSync(path.join(ROOT, 'tools/fixtures/handwritten.http'))
  ? fs.readFileSync(path.join(ROOT, 'tools/fixtures/handwritten.http'), 'utf8')
  : '';

function seed() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(RESULTS, { recursive: true });
  const files = [
    ['本地自测.http', DEMO_HTTP],
    ['示例 · 宠物店.http', HAND],
    ['http-client.env.json', JSON.stringify(ENV_FILE, null, 2) + '\n'],
  ];
  for (const [name, body] of files) {
    const p = path.join(WORK, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, body, 'utf8');
  }
  const gi = path.join(WORK, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '_history/\n_results/\n', 'utf8');
}

/* ---------------- 文件系统小工具 ---------------- */

const isHttp = (n) => /\.(http|rest)$/i.test(n);

function collectHttpFiles(dir, recursive, depth, out) {
  if (out.length >= 200 || depth > 3) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of ents) {
    if (out.length >= 200) break;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!recursive) continue;
      if (ent.name.startsWith('.') || ['node_modules', 'target', 'dist', 'build', 'vendor', 'AppData'].includes(ent.name)) continue;
      collectHttpFiles(p, true, depth + 1, out);
      continue;
    }
    if (!isHttp(ent.name)) continue;
    let st = null;
    try { st = fs.statSync(p); } catch (e) { continue; }
    out.push({ path: p, name: ent.name, size: st.size, modified: Math.round(st.mtimeMs) });
  }
}

function readJsonOrNull(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function resolveDir(raw) {
  const d = raw ? path.resolve(String(raw)) : WORK;
  return d;
}

/* ---------------- invoke 路由 ---------------- */

const handlers = {
  'http/defaultDirs': async () => ({ resultsDir: RESULTS, homeDir: WORK, workDir: WORK }),

  'http/listFiles': async (p) => {
    const dir = resolveDir(p.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('目录不存在: ' + dir);
    const files = [];
    collectHttpFiles(dir, p.recursive !== false, 0, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { dir, files };
  },

  'http/readFile': async (p) => {
    if (!p.path) throw new Error('缺少 path');
    const content = fs.readFileSync(p.path, 'utf8');
    const st = fs.statSync(p.path);
    return { path: p.path, content, name: path.basename(p.path), dir: path.dirname(p.path), size: st.size, modified: Math.round(st.mtimeMs) };
  },

  'http/writeFile': async (p) => {
    if (!p.path) throw new Error('缺少 path');
    fs.mkdirSync(path.dirname(p.path), { recursive: true });
    const text = p.content == null ? '' : String(p.content);
    const tmp = p.path + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8');
    try { fs.renameSync(tmp, p.path); } catch (e) { fs.writeFileSync(p.path, text, 'utf8'); try { fs.unlinkSync(tmp); } catch (_) { } }
    const st = fs.statSync(p.path);
    return { path: p.path, written: true, size: st.size, modified: Math.round(st.mtimeMs) };
  },

  'http/statFile': async (p) => {
    if (!p.path) throw new Error('缺少 path');
    if (!fs.existsSync(p.path)) return { path: p.path, exists: false, size: 0, modified: 0 };
    const st = fs.statSync(p.path);
    return { path: p.path, exists: true, size: st.size, modified: Math.round(st.mtimeMs) };
  },

  'http/deleteFile': async (p) => {
    if (!p.path) throw new Error('缺少 path');
    if (fs.existsSync(p.path)) fs.unlinkSync(p.path);
    return { path: p.path, removed: true };
  },

  'http/renameFile': async (p) => {
    if (!p.from || !p.to) throw new Error('缺少 from/to');
    if (p.overwrite && fs.existsSync(p.to)) { try { fs.unlinkSync(p.to); } catch (e) { } }
    fs.renameSync(p.from, p.to);
    return { path: p.to, renamed: true };
  },

  'http/ensureDir': async (p) => {
    const dir = resolveDir(p.dir);
    fs.mkdirSync(dir, { recursive: true });
    return { dir };
  },

  'http/readEnvFiles': async (p) => {
    const base = resolveDir(p.dir);
    return {
      dir: base,
      public: readJsonOrNull(path.join(base, 'http-client.env.json')),
      private: readJsonOrNull(path.join(base, 'http-client.private.env.json')),
    };
  },

  /* 原生文件对话框：浏览器里没有，明确告知走输入框降级 */
  'http/pickFile': async () => ({ cancelled: true, unavailable: true, error: '浏览器调试模式没有系统文件对话框，请用输入框直接填路径' }),
  'http/revealDir': async (p) => ({ path: resolveDir(p.dir), revealed: false }),

  'http/request': async (p) => doRequest(p),

  'http/listResults': async () => {
    const items = [];
    let ents = [];
    try { ents = fs.readdirSync(RESULTS, { withFileTypes: true }); } catch (e) { }
    for (const ent of ents) {
      if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
      const fp = path.join(RESULTS, ent.name);
      const v = readJsonOrNull(fp);
      if (!v) continue;
      const req = v.request || {}, resp = v.response || {};
      items.push({
        path: fp, id: v.id || '', savedAt: v.savedAt || 0,
        name: req.name || '', method: req.method || '', url: req.url || '',
        status: resp.status || 0, timeMs: resp.timeMs || 0, size: resp.size || 0,
      });
    }
    items.sort((a, b) => b.savedAt - a.savedAt);
    return { dir: RESULTS, items };
  },

  'http/getResult': async (p) => {
    const v = readJsonOrNull(p.path);
    if (!v) throw new Error('结果不存在: ' + p.path);
    return v;
  },

  'http/saveResult': async (p) => {
    fs.mkdirSync(RESULTS, { recursive: true });
    const ts = Date.now();
    const id = ts + '-' + String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
    const entry = Object.assign({}, p.entry || {}, { id, savedAt: ts });
    const fp = path.join(RESULTS, id + '.json');
    fs.writeFileSync(fp, JSON.stringify(entry, null, 2), 'utf8');
    return { path: fp, id };
  },

  'http/deleteResult': async (p) => {
    if (p.path && fs.existsSync(p.path)) fs.unlinkSync(p.path);
    return { path: p.path, removed: true };
  },
};

/* ---------------- 真发请求 ---------------- */

const BIN_TYPE = /^(image|audio|video|font)\/|octet-stream|pdf|zip|gzip|wasm/i;

/* 订阅式流（调试宿主）：把上游 SSE 的每一块用 `event: chunk` 推给浏览器，
 * 页面侧 mock-host 再转成 dbx-host/event 的 postMessage —— 与真宿主同一条路径。 */
async function streamRequest(res, p) {
  const sid = p.streamRequestId;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const ev = (name, data) => { res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'); };
  const t0 = Date.now();
  try {
    const url = p.url;
    if (!url) throw new Error('缺少 url');
    const method = String(p.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of Object.entries(p.headers || {})) {
      if (v == null || v === '') continue;
      headers[k] = String(v);
    }
    let body;
    if (p.bodyBase64) body = Buffer.from(p.bodyBase64, 'base64');
    else if (p.body && !['GET', 'HEAD'].includes(method)) body = String(p.body);
    const timeout = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 0;
    const r = await fetch(url, {
      method, headers, body, redirect: 'follow',
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    const ct = r.headers.get('content-type') || '';
    const resHeaders = {};
    r.headers.forEach((v, k) => { resHeaders[k] = v; });
    ev('open', {
      requestId: sid, phase: 'open', status: r.status, statusText: r.statusText,
      ok: r.ok, contentType: ct, headers: resHeaders,
    });
    if (!/text\/event-stream/i.test(ct)) {
      /* 不是 SSE 就整包回：界面照常显示，只是没有「边到边看」 */
      const buf = Buffer.from(await r.arrayBuffer());
      const isBin = BIN_TYPE.test(ct);
      ev('result', {
        status: r.status, statusText: r.statusText, ok: r.ok, contentType: ct, headers: resHeaders,
        body: isBin ? buf.toString('base64') : buf.toString('utf8'), isBase64: isBin,
        size: buf.length, timeMs: Date.now() - t0, streamed: false,
      });
      res.end();
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let acc = '', seq = 0, total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      acc += dec.decode(value, { stream: true });
      let i;
      while ((i = acc.indexOf('\n\n')) >= 0) {
        const chunk = acc.slice(0, i + 2);
        acc = acc.slice(i + 2);
        ev('chunk', { requestId: sid, seq: ++seq, chunk });
      }
    }
    if (acc) ev('chunk', { requestId: sid, seq: ++seq, chunk: acc });
    const timeMs = Date.now() - t0;
    ev('done', {
      requestId: sid, done: true, seq: seq + 1, status: r.status, statusText: r.statusText,
      ok: r.ok, contentType: ct, headers: resHeaders, size: total, timeMs,
    });
    ev('result', {
      status: r.status, statusText: r.statusText, ok: r.ok, contentType: ct, headers: resHeaders,
      body: '', isBase64: false, size: total, timeMs, sse: true, streamed: true,
      cancelled: false, truncated: false,
    });
    res.end();
  } catch (e) {
    ev('fail', { requestId: sid, error: 'send: ' + ((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e) });
    res.end();
  }
}

async function doRequest(p) {
  const url = p.url;
  if (!url) throw new Error('缺少 url');
  const method = String(p.method || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries(p.headers || {})) {
    if (v == null || v === '') continue;
    headers[k] = String(v);
  }
  let body;
  if (p.bodyBase64) {
    body = Buffer.from(p.bodyBase64, 'base64');
  } else if (p.body && !['GET', 'HEAD'].includes(method)) {
    body = String(p.body);
    const hasCT = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!hasCT) {
      if (p.bodyType === 'json') headers['Content-Type'] = 'application/json';
      else if (p.bodyType === 'form') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }

  const timeout = Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 0;
  const signal = timeout ? AbortSignal.timeout(timeout) : undefined;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: 'follow', signal });
  } catch (e) {
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    throw new Error('send: ' + (cause || (e && e.message) || e));
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const timeMs = Date.now() - t0;
  const contentType = res.headers.get('content-type') || '';
  const isBinary = BIN_TYPE.test(contentType);
  const resHeaders = {};
  res.headers.forEach((v, k) => { resHeaders[k] = v; });
  return {
    status: res.status,
    statusText: res.statusText || '',
    ok: res.ok,
    contentType,
    headers: resHeaders,
    body: isBinary ? buf.toString('base64') : buf.toString('utf8'),
    isBase64: isBinary,
    size: buf.length,
    timeMs,
    sse: contentType.toLowerCase().includes('text/event-stream'),
    sseTruncated: false,
  };
}

/* ---------------- 假接口（/api/*） ---------------- */

function json(res, code, obj) {
  const s = JSON.stringify(obj, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'X-Demo-Server': 'wpa-dev' });
  res.end(s);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, u) {
  const delay = Number(u.searchParams.get('ms') || 0);
  if (u.pathname === '/api/slow') await new Promise((r) => setTimeout(r, Math.min(delay || 3000, 60000)));
  if (u.pathname === '/api/500') return json(res, 500, { ok: false, error: '演示用的服务端错误' });
  if (u.pathname === '/api/big') {
    const n = Math.min(Number(u.searchParams.get('n') || 100), 2000);
    const items = Array.from({ length: n }, (_, i) => ({
      id: 1000 + i, name: '宠物 ' + (i + 1), kind: i % 3 === 0 ? 'cat' : 'dog',
      tags: ['tag' + (i % 7), 'g' + (i % 3)], bornAt: '2024-0' + ((i % 9) + 1) + '-1' + (i % 9),
    }));
    return json(res, 200, { page: 1, pageSize: n, total: n, items });
  }
  if (u.pathname === '/api/login') {
    const body = await readBody(req);
    return json(res, 200, { ok: true, token: 'tok-demo', receivedBody: body, contentType: req.headers['content-type'] || '' });
  }
  if (u.pathname === '/api/pets') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) { }
      return json(res, 201, { ok: true, created: parsed || body, at: new Date().toISOString() });
    }
    return json(res, 200, {
      ok: true, total: 3,
      items: [{ id: 1, name: '旺财', kind: 'dog' }, { id: 2, name: '咪咪', kind: 'cat' }, { id: 3, name: '小强', kind: 'turtle' }],
    });
  }
  /* 兜底：任何 /api/* 都回显，方便随手改 URL 也有响应 */
  const body = await readBody(req);
  return json(res, 200, {
    ok: true, method: req.method, path: u.pathname,
    query: Object.fromEntries(u.searchParams), body, headers: req.headers,
  });
}

/* ---------------- HTTP 服务器 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + HOST + ':' + PORT);

  if (u.pathname === '/__dev/invoke' && req.method === 'POST') {
    let payload = {};
    try {
      payload = JSON.parse(await readBody(req) || '{}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '请求体不是 JSON' }));
      return;
    }
    const fn = handlers[payload.method];
    if (!fn) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未实现的命令：' + payload.method }));
      return;
    }
    try {
      /* 订阅式流：不返回 JSON，而是把每一块用 SSE 推回去。
       * 页面侧 mock-host 收到后再 postMessage 成 dbx-host/event —— 与真宿主同一条路径。 */
      if (payload.method === 'http/request' && payload.params && payload.params.stream && payload.params.streamRequestId) {
        await streamRequest(res, payload.params);
        return;
      }
      const result = await fn(payload.params || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
    }
    return;
  }

  if (u.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, u); } catch (e) {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  /* 静态资源 */
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const fp = path.join(UI_DIR, rel.replace(/^\/+/, ''));
  if (!fp.startsWith(UI_DIR)) { res.writeHead(403); res.end('forbidden'); return; }

  if (rel === '/index.html') {
    let html = '';
    try { html = await fsp.readFile(fp, 'utf8'); } catch (e) { res.writeHead(404); res.end('index.html 不存在'); return; }
    html = html.replace('</head>', '  <script src="/__dev/mock-host.js"></script>\n</head>');
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (rel === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (rel === '/__dev/mock-host.js') {
    const mh = path.join(HERE, 'mock-host.js');
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
    res.end(await fsp.readFile(mh, 'utf8'));
    return;
  }

  try {
    const buf = await fsp.readFile(fp);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + rel);
  }
});

seed();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  插件调试环境已启动');
  console.log('  ─────────────────────────────────────────');
  console.log('  地址      http://' + HOST + ':' + PORT + '/');
  console.log('  数据目录  ' + WORK);
  console.log('  假接口    http://' + HOST + ':' + PORT + '/api/pets 等');
  console.log('  说明      宿主是本地假宿主（dev/mock-host.js），文件读写与 HTTP 请求都是真的');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，换一个：PORT=9000 node dev/dev-server.mjs');
  } else {
    console.error('启动失败：', e.message);
  }
  process.exit(1);
});
