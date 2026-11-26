/* http-history.js — 调用历史：先落身份，再落一行 jsonl。
 *
 * 职责（S4.2 + S4.3）：
 *   1. record() 的两步走 —— 先把 # @file_id / # @interface_id 写进 .http 并等写盘成功，
 *      **再**把这一条调用追加进 `_history/<collection>/<interfaceId>.jsonl`；
 *      写身份失败（只读 / 冲突重试 2 次仍失败 / 段找不到）就**不写历史**，
 *      历史里绝不能出现"文件里没有的 id"。
 *   2. 一个接口一个 jsonl，超过 MAX_LINES（用户 2026-11-20 拍板 = 10）就轮转，只留最近 10 条。
 *   3. 二进制响应外置成同目录的 `.bin`，jsonl 只留 bodyRef / bodyBytes，行不会被撑爆。
 *   4. read() 把 jsonl 读成数组，坏行（截断的 JSON）跳过不报错 —— 一行坏不能拖垮整份历史。
 *   5. ensureGitignore() 往资源目录 .gitignore 追加一行 `_history/`，已有就不动。
 *
 * 关于 `.bin` 里装的是什么：宿主（DBX sidecar）只提供文本写（host.write 走 utf8），
 * 没有二进制写接口，所以 `.bin` 落的是 base64 文本，jsonl 里用 `bodyEncoding: 'base64'`
 * 标清楚。文件名后缀保持 `.bin` 是为了与 plan 对齐；读的时候先看 bodyEncoding 再解码。
 *
 * 依赖注入：store 由调用方给（浏览器里是 POLARIS_DOCS.store，Node 里是 createStore(fsHost)），
 * 目录 dir 也由调用方给，所以本文件不读宿主、不碰 DOM，可以直接 require 做单测。
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;

  var HISTORY_DIR = '_history';
  var FORMAT_VERSION = 1;            /* S7.1 冻结：jsonl 每行的 `v` 字段，也是 _meta.json 的 formatVersion */
  var META_NAME = '_meta.json';      /* `_history/_meta.json`：整份历史的格式版本，迁移时先看它 */
  var APP_ID = 'com.zsky1.apifox';
  var MAX_LINES = 10;                /* 每个接口保留几条：用户 2026-11-20 拍板 = 10 */
  var MAX_RETRY = 2;                 /* 冲突后最多再试 2 次（共 3 次写） */
  var BIN_TRY = 20;                  /* .bin 重名时最多往后找 20 个序号 */

  function requireFile() {
    if (root.POLARIS_HTTP) return root.POLARIS_HTTP;
    if (typeof require === 'function') return require('./http-file.js');
    throw new Error('http-file.js 未加载');
  }
  function requireIdentity() {
    if (root.POLARIS_IDENTITY) return root.POLARIS_IDENTITY;
    if (typeof require === 'function') return require('./http-identity.js');
    throw new Error('http-identity.js 未加载');
  }
  function requireStore() {
    if (root.POLARIS_STORE) return root.POLARIS_STORE;
    if (typeof require === 'function') return require('./http-store.js');
    throw new Error('http-store.js 未加载');
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* 文件名 → collection 名（去掉 .http / .rest 后缀） */
  function collectionName(path) {
    var s = String(path || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (i >= 0 ? s.slice(i + 1) : s).replace(/\.(http|rest)$/i, '') || 'collection';
  }

  function historyBase(dir) {
    var S = requireStore();
    return S.joinPath(dir, HISTORY_DIR);
  }

  /* `_history/_meta.json`：整份历史的格式版本。
   * 有它就不必逐文件嗅探；没有（0.9.x 之前写的）一律按 v1 读。 */
  function metaPath(dir) {
    var S = requireStore();
    return S.joinPath(historyBase(dir), META_NAME);
  }

  /* `_history/<collection>/<interfaceId>.jsonl`（绝对路径由 dir 拼出来） */
  function historyPath(dir, filePath, interfaceId) {
    return historyPathFor(dir, collectionName(filePath), interfaceId);
  }
  function historyPathFor(dir, collection, interfaceId) {
    var S = requireStore();
    var base = S.joinPath(historyBase(dir), S.sanitizeName(collection || 'collection'));
    return S.joinPath(base, String(interfaceId || 'unknown') + '.jsonl');
  }

  /* ---------------- 文本读写小工具 ---------------- */

  /* 读纯文本；不存在（或读失败）就返回 fallback，不抛 */
  async function readTextOr(store, path, fallback) {
    try {
      var rd = await store.host.read(path);
      return String((rd && rd.content) || '');
    } catch (e) { return fallback; }
  }

  function splitNonEmpty(text) {
    if (!text) return [];
    return String(text).split(/\r?\n/).filter(function (s) { return s.trim() !== ''; });
  }

  /* 同一路径的 read-modify-write 串成一条链：连发两次时后一次能看见前一次的结果。
   * 光靠唯一 tmp 名只能防「写坏」，防不了「丢更新」，所以这里仍然串行。 */
  var chains = Object.create(null);
  function serial(key, fn) {
    var prev = chains[key] || Promise.resolve();
    var run = prev.then(function () { return fn(); }, function () { return fn(); });
    chains[key] = run.then(function () { }, function () { });
    return run;
  }

  /* ---------------- 轮转 ---------------- */

  /* 纯函数：把整份文本裁到最近 max 行。max <= 0 表示不裁。 */
  function rotateText(text, max) {
    var eol = String(text || '').indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = splitNonEmpty(text);
    var dropped = 0;
    var want = max == null ? MAX_LINES : num(max);
    if (want > 0 && lines.length > want) {
      dropped = lines.length - want;
      lines = lines.slice(-want);
    }
    return { text: lines.length ? lines.join(eol) + eol : '', lines: lines.length, dropped: dropped };
  }

  /* 追加一行；超出上限就在同一次写里裁掉最旧的。
   * 返回 lines = 写完之后的条数，dropped = 本次扔掉几条。
   * 若这份 jsonl 里已经有更高版本（v > FORMAT_VERSION）的行，**一行都不写** ——
   * 只读展示、提示升级，别把新版本的数据混进旧解释器里。 */
  async function appendEntry(store, path, line, o) {
    o = o || {};
    var want = o.max == null ? MAX_LINES : num(o.max);
    var prev = await readTextOr(store, path, '');
    var mine = maxVersion(parseJsonl(prev).rows);
    if (mine > FORMAT_VERSION) {
      return { ok: false, reason: 'FUTURE_FORMAT', lines: 0, dropped: 0, formatVersion: mine };
    }
    var eol = String(prev).indexOf('\r\n') >= 0 ? '\r\n' : '\n';
    var lines = splitNonEmpty(prev);
    var one = String(line == null ? '' : line).replace(/[\r\n]+$/, '');
    if (one) lines.push(one);
    var dropped = 0;
    if (want > 0 && lines.length > want) {
      dropped = lines.length - want;
      lines = lines.slice(-want);
    }
    var text = lines.length ? lines.join(eol) + eol : '';
    var w = await store.writeText(path, text, {});
    if (!w || !w.ok) return { ok: false, reason: (w && w.reason) || 'WRITE_FAILED', lines: 0, dropped: 0 };
    return { ok: true, lines: lines.length, dropped: dropped };
  }

  /* 单独触发轮转（维护入口；appendEntry 里已经顺手做了） */
  async function rotateFile(store, path, max) {
    var prev = await readTextOr(store, path, '');
    var r = rotateText(prev, max);
    if (!r.dropped) return { ok: true, dropped: 0, lines: r.lines };
    var w = await store.writeText(path, r.text, {});
    if (!w || !w.ok) return { ok: false, reason: (w && w.reason) || 'WRITE_FAILED', dropped: 0, lines: 0 };
    return { ok: true, dropped: r.dropped, lines: r.lines };
  }

  /* ---------------- 读取 ---------------- */

  /* 解析 jsonl 文本。坏行（截断 / 不是对象）跳过并计入 bad，不影响其余行。
   * 每行原文挂在**不可枚举**的 `__raw` 上：合并/重写时原样吐回去，
   * 未知字段、键序、空白都不会被 JSON.parse → stringify 这趟来回洗掉。 */
  function parseJsonl(text) {
    var rows = [];
    var bad = 0;
    var lines = splitNonEmpty(text);
    for (var i = 0; i < lines.length; i++) {
      var v;
      try { v = JSON.parse(lines[i]); } catch (e) { bad++; continue; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { bad++; continue; }
      Object.defineProperty(v, '__raw', { value: lines[i], enumerable: false, configurable: true });
      rows.push(v);
    }
    return { rows: rows, bad: bad, total: lines.length };
  }

  /* 这些行里最高的格式版本；没有 v 字段（0.9.x 写的）按 v1 算，没有行算 0。 */
  function maxVersion(rows) {
    var m = 0;
    for (var i = 0; i < (rows || []).length; i++) {
      var v = num(rows[i] && rows[i].v);
      if (v > m) m = v;
    }
    return m;
  }

  /* read({store, dir, collection, interfaceId}) 或 read({store, path})
   * 返回行的顺序与文件一致（旧 → 新），面板要倒序自己 reverse。 */
  async function read(o) {
    o = o || {};
    var store = o.store;
    if (!store) return { ok: false, reason: 'NO_STORE', rows: [], bad: 0 };
    var path = o.path || historyPathFor(o.dir, o.collection, o.interfaceId);
    if (!path) return { ok: false, reason: 'NO_PATH', rows: [], bad: 0 };
    var text;
    try {
      var rd = await store.host.read(path);
      text = String((rd && rd.content) || '');
    } catch (e) {
      /* 没有历史不是错：第一次调用之前本来就该是空的 */
      return { ok: true, path: path, rows: [], bad: 0, total: 0, missing: true, formatVersion: FORMAT_VERSION, future: false };
    }
    var p = parseJsonl(text);
    var fv = maxVersion(p.rows) || FORMAT_VERSION;
    return {
      ok: true, path: path, rows: p.rows, bad: p.bad, total: p.total, missing: false,
      formatVersion: fv, future: fv > FORMAT_VERSION
    };
  }

  /* ---------------- 二进制外置 ---------------- */

  /* plan 点名的几类：image / audio / octet-stream / zip；顺手带上 video、font、pdf、gzip、rar，
   * 它们同样是 base64 塞进 jsonl 会把行撑到几 MB 的东西。 */
  var BIN_TYPE_RE = /^(image|audio|video|font)\//;
  var BIN_APP_RE = /^application\/(octet-stream|zip|x-zip-compressed|gzip|x-gzip|pdf|x-7z-compressed|x-rar-compressed|vnd\.rar)/;

  function isBinaryContentType(ct) {
    var s = String(ct || '').toLowerCase().split(';')[0].trim();
    if (!s) return false;
    return BIN_TYPE_RE.test(s) || BIN_APP_RE.test(s) || /\+zip$/.test(s);
  }

  /* base64 → 解出来的字节数（不真解码，浏览器里没有 Buffer） */
  function b64Bytes(b64) {
    var s = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
    if (!s) return 0;
    var pad = (s.match(/=+$/) || [''])[0].length;
    return Math.max(0, Math.floor(s.length * 3 / 4) - pad);
  }

  function binNameFor(interfaceId, at, n) {
    return String(interfaceId || 'unknown') + '-' + at + (n > 1 ? '-' + n : '') + '.bin';
  }

  /* 把 base64 落到 `_history/<collection>/<id>-<at>.bin`，返回相对 collection 目录的文件名。
   * 上限 maxBodyBytes 默认 Infinity（函数层），调用方传 5 MB ——
   * 这个数不是拍脑袋：宿主单条 JSON 消息硬顶 8 MiB（SDK MAX_JSON_BYTES），
   * 二进制响应要 base64 装在 JSON 里，膨胀 4/3，原始体约 6 MiB 就会把整条消息顶穿
   * （不是历史存不下，是这次响应压根回不来）。5 MB 比硬顶低约 20%，留出余量；
   * 超了就只丢 .bin，历史行照记 TOO_LARGE。 */
  async function writeBody(store, dir, collection, interfaceId, at, b64, o) {
    o = o || {};
    var S = requireStore();
    var b = String(b64 || '');
    if (!b) return { ok: false, reason: 'NO_BODY' };
    var bytes = b64Bytes(b);
    var max = o.maxBodyBytes == null ? Infinity : num(o.maxBodyBytes);
    if (max > 0 && bytes > max) return { ok: false, reason: 'TOO_LARGE', bytes: bytes };

    var base = S.joinPath(historyBase(dir), S.sanitizeName(collection || 'collection'));
    try { await store.host.ensureDir(base); } catch (e) { /* 写的时候还会再失败一次 */ }

    var ref = null;
    var target = null;
    for (var n = 1; n <= BIN_TRY; n++) {
      var name = binNameFor(interfaceId, at, n);
      var p = S.joinPath(base, name);
      var st = null;
      try { st = await store.host.stat(p); } catch (e) { st = null; }
      if (!st || !st.exists) { ref = name; target = p; break; }
    }
    if (!ref) return { ok: false, reason: 'NAME_EXHAUSTED' };

    var w = await store.writeText(target, b, {});
    if (!w || !w.ok) return { ok: false, reason: (w && w.reason) || 'WRITE_FAILED' };
    return { ok: true, ref: ref, path: target, bytes: bytes };
  }

  /* ---------------- 身份索引（S4.6 用） ----------------
   * 宿主只能按 .http 列目录（`http/listFiles` 按扩展名过滤），拿不到 `_history/` 下的文件清单，
   * 所以「按指纹找回旧 id」不能靠扫目录。这里维护一份同目录下的 `.identities.jsonl`：
   * 每写一条历史就追加一行 { fp, id, at }，查的时候只读这一个已知路径。
   * 它只是**候选来源**，命中后还会 stat 一下对应 jsonl 是否还在 —— 合并过的旧 id 自然失效。
   */
  var IDX_NAME = '.identities.jsonl';
  var IDX_MAX = 400;

  function indexPath(dir, collection) {
    var S = requireStore();
    return S.joinPath(S.joinPath(historyBase(dir), S.sanitizeName(collection || 'collection')), IDX_NAME);
  }

  async function noteIdentity(store, dir, collection, fingerprint, interfaceId, at) {
    if (!store || !dir || !fingerprint || !interfaceId) return { ok: false, reason: 'NOT_ENOUGH' };
    var S = requireStore();
    var p = indexPath(dir, collection);
    try { await store.host.ensureDir(S.dirName(p)); } catch (e) { /* 写时会再失败一次 */ }
    var line = JSON.stringify({ fp: String(fingerprint), id: String(interfaceId), at: num(at) || Date.now() }) + '\n';
    return serial(p, function () { return appendEntry(store, p, line, { max: IDX_MAX }); });
  }

  /* 按指纹找回旧 id：返回最近一条仍在磁盘上、且不是 excludeId 的记录 */
  async function findByIdentity(o) {
    o = o || {};
    var store = o.store;
    if (!store || !o.dir || !o.fingerprint) return { ok: false, reason: 'NOT_ENOUGH', interfaceId: null };
    var p = indexPath(o.dir, o.collection);
    var text = await readTextOr(store, p, '');
    var rows = parseJsonl(text).rows.filter(function (r) {
      return r && r.fp === String(o.fingerprint) && r.id && r.id !== o.excludeId;
    });
    if (!rows.length) return { ok: true, interfaceId: null, candidates: [] };
    rows.sort(function (a, b) { return num(a.at) - num(b.at); });
    var seen = Object.create(null);
    var hits = [];
    for (var i = rows.length - 1; i >= 0; i--) {
      var id = rows[i].id;
      if (seen[id]) continue;
      seen[id] = 1;
      var hp = historyPathFor(o.dir, o.collection, id);
      var st = null;
      try { st = await store.host.stat(hp); } catch (e) { st = null; }
      if (!st || !st.exists) continue;                   /* 已经被合并掉的旧 id */
      var got = await read({ store: store, path: hp });
      hits.push({ interfaceId: id, at: num(rows[i].at), count: got.ok ? got.rows.length : 0, path: hp });
      if (hits.length >= 3) break;
    }
    return { ok: true, interfaceId: hits.length ? hits[0].interfaceId : null, hit: hits[0] || null, candidates: hits };
  }

  /* 把 fromId 的历史并进 toId，然后把 fromId 的 jsonl 删掉（S4.6「接回」的第二步） */
  async function mergeInto(store, dir, collection, fromId, toId, max) {
    if (!store || !fromId || !toId || fromId === toId) return { ok: false, reason: 'SAME_ID' };
    var fromPath = historyPathFor(dir, collection, fromId);
    var toPath = historyPathFor(dir, collection, toId);
    var a = await read({ store: store, path: fromPath });
    var b = await read({ store: store, path: toPath });
    if (!a.ok) return { ok: false, reason: 'READ_FAILED' };
    var rows = (b.rows || []).concat(a.rows || []);
    rows.sort(function (x, y) { return num(x.at) - num(y.at); });
    var want = max == null ? MAX_LINES : num(max);
    if (want > 0 && rows.length > want) rows = rows.slice(-want);
    /* 有 __raw 就原样写回：未知字段、键序、数字写法都不动（只做排序与裁剪） */
    var text = rows.map(function (r) { return r.__raw || JSON.stringify(r); }).join('\n') + (rows.length ? '\n' : '');
    var SS = requireStore();
    try { await store.host.ensureDir(SS.dirName(toPath)); } catch (e) { /* 写的时候还会再失败一次 */ }
    var w = await store.writeText(toPath, text, {});
    if (!w || !w.ok) return { ok: false, reason: (w && w.reason) || 'WRITE_FAILED' };
    try { await store.host.remove(fromPath); } catch (e) { /* 删不掉就留着，不影响读 */ }
    return { ok: true, rows: rows.length, from: fromPath, to: toPath };
  }

  /* 「接回」：文件里的 id 换回旧的 + 把新 id 的历史并进旧 id。
   * 顺序不能反 —— 先把历史并过去、再改文件，中途失败会留下两份同 id 的文件；
   * 先改文件再并历史，最坏情况是历史暂时少一条，用户重发一次就补上。 */
  async function reuse(store, o) {
    o = o || {};
    var H = requireFile(), I = requireIdentity(), S = requireStore();
    if (!store || !o.dir || !o.path || !o.toId) return { ok: false, reason: 'NOT_ENOUGH' };
    var cur;
    try { cur = await readDoc(store, o.path); } catch (e) { return { ok: false, reason: 'NOT_FOUND' }; }
    var idx = S.locateSegment(cur.parsed, o.req || {});
    if (idx < 0) return { ok: false, reason: 'NO_SEGMENT' };
    var target = cur.parsed.requests[idx];
    var r = I.retagInterfaceId(cur.text, { line: target.line }, o.toId);
    if (!r.changed) {
      if (r.reason) return { ok: false, reason: r.reason };
    } else {
      var w = await store.writeText(o.path, r.text, { baseMtime: cur.mtime });
      if (!w || !w.ok) return { ok: false, reason: (w && w.reason) || 'WRITE_FAILED' };
    }
    var mtime = cur.mtime;
    try {
      var st = await store.host.stat(o.path);
      mtime = Math.round((st && st.modified) || 0);
    } catch (e) { /* 拿不到 mtime 不影响接回 */ }
    var merged = await mergeInto(store, o.dir, o.collection, o.fromId, o.toId, o.max);
    return {
      ok: true, changed: !!r.changed, mtime: mtime, interfaceId: String(o.toId),
      merged: merged.ok, mergedRows: merged.rows || 0, mergeReason: merged.ok ? null : (merged.reason || null)
    };
  }

  /* ---------------- _meta.json（S7.1 冻结） ---------------- */

  /* 只在**没有**的时候建：已有的绝不覆盖 —— 里面可能写着更新版本的 formatVersion，
   * 覆盖等于把「该升级了」这个信号抹掉。读不懂也留着，只报告 META_UNREADABLE。 */
  async function ensureMeta(store, dir) {
    if (!store || !dir) return { ok: false, reason: 'NO_DIR' };
    var p = metaPath(dir);
    var cur = await readTextOr(store, p, null);
    if (cur != null) {
      var got = null;
      try { got = JSON.parse(cur); } catch (e) { got = null; }
      if (got && typeof got === 'object' && num(got.formatVersion) > 0) {
        return { ok: true, path: p, existed: true, changed: false, formatVersion: num(got.formatVersion) };
      }
      return { ok: false, path: p, reason: 'META_UNREADABLE' };
    }
    var S = requireStore();
    try { await store.host.ensureDir(S.dirName(p)); } catch (e) { /* 写的时候还会再失败一次 */ }
    var body = JSON.stringify({
      formatVersion: FORMAT_VERSION,
      app: APP_ID,
      createdAt: new Date().toISOString()
    }) + '\n';
    var w = await store.writeText(p, body, {});
    return w && w.ok ? { ok: true, path: p, created: true, changed: true, formatVersion: FORMAT_VERSION }
                     : { ok: false, reason: (w && w.reason) || 'WRITE_FAILED' };
  }

  /* ---------------- .gitignore ---------------- */
  var giTried = Object.create(null);     /* 每个 dir 只试一次，失败也不反复读盘 */
  var metaTried = Object.create(null);   /* 同上：_meta.json 每个资源目录只种一次 */

  async function ensureGitignore(store, dir) {
    if (!store || !dir) return { ok: false, reason: 'NO_DIR' };
    var S = requireStore();
    var p = S.joinPath(dir, '.gitignore');
    var cur = await readTextOr(store, p, null);
    if (cur == null) {                   /* 没有就建一个，只放这一行 */
      var w0 = await store.writeText(p, HISTORY_DIR + '/\n', {});
      return w0 && w0.ok ? { ok: true, path: p, created: true, changed: true }
                         : { ok: false, reason: (w0 && w0.reason) || 'WRITE_FAILED' };
    }
    var lines = String(cur).split(/\r?\n/).map(function (s) { return s.trim(); });
    var has = lines.some(function (l) {
      return l === HISTORY_DIR + '/' || l === HISTORY_DIR || l === '/' + HISTORY_DIR + '/' || l === '/' + HISTORY_DIR;
    });
    if (has) return { ok: true, path: p, existed: true, changed: false };
    var add = (cur && cur.charAt(cur.length - 1) !== '\n' ? '\n' : '') + HISTORY_DIR + '/\n';
    var w = await store.writeText(p, String(cur) + add, {});
    return w && w.ok ? { ok: true, path: p, existed: true, changed: true }
                     : { ok: false, reason: (w && w.reason) || 'WRITE_FAILED' };
  }

  /* ---------------- 条目 ---------------- */

  /* 历史条目。字段名就是将来读出来给人看的名字，别缩写。 */
  function entryFor(o) {
    var I = requireIdentity();
    var resp = o.response || {};
    var tpl = String(o.urlTemplate != null ? o.urlTemplate : (o.url || ''));
    var entry = {
      v: FORMAT_VERSION,              /* 必须是首字段：S7.1 冻结，先看版本再看别的 */
      at: num(o.at) || Date.now(),
      status: num(resp.status),
      ok: !!resp.ok,
      timeMs: num(resp.timeMs),
      size: num(resp.size),
      method: String(o.method || 'GET').toUpperCase(),
      url: String(o.url || tpl),
      urlTemplate: tpl,
      fingerprint: I.fingerprint({ method: o.method, url: tpl }),
      contentType: String(resp.contentType || ''),
      interfaceId: o.interfaceId || null,
      fileId: o.fileId || null,
      file: String(o.file || ''),
      name: String(o.name || '')
    };
    /* S8.6：这次调用在 _results/ 里对应的那条完整结果（有就有，没有就不写这个字段）。
     * 只存摘要是 S4 的既定口径 —— 历史是「调用日志」，完整响应在 _results/ 里；
     * 这里只加一个指针，让历史行能跳到那份快照，不把正文塞进 jsonl。 */
    if (o.resultPath) entry.resultPath = String(o.resultPath);
    return entry;
  }

  /* 读一个 .http 的当前磁盘状态。读不到就抛，交给 record 变成 NOT_FOUND。 */
  async function readDoc(store, path) {
    var H = requireFile();
    var rd = await store.host.read(path);
    var st = await store.host.stat(path);
    var text = String(rd && rd.content != null ? rd.content : '');
    var name = String(path).split(/[\\/]/).pop();
    return {
      text: text,
      mtime: Math.round((st && st.modified) || 0),
      parsed: H.parseHttpFile(text, { fileName: name })
    };
  }

  function createHistory(opts) {
    opts = opts || {};
    var maxLines = opts.max == null ? MAX_LINES : num(opts.max);
    var maxBody = opts.maxBodyBytes == null ? Infinity : opts.maxBodyBytes;

    async function record(input) {
      input = input || {};
      var store = input.store || opts.store;
      var dir = input.dir || opts.dir;
      var path = input.path;
      if (!store || !dir || !path) return { ok: false, reason: 'NOT_FILE' };

      var H = requireFile(), I = requireIdentity(), S = requireStore();
      var req = input.req || {};
      var resp = input.response || {};
      var attempt = 0;

      while (attempt <= MAX_RETRY) {
        var cur;
        try { cur = await readDoc(store, path); }
        catch (e) { return { ok: false, reason: 'NOT_FOUND' }; }

        /* 先定位段（用磁盘上的原始行号），再插 file_id —— 反过来的话行号已经漂了 */
        var idx = S.locateSegment(cur.parsed, req);
        if (idx < 0) return { ok: false, reason: 'NO_SEGMENT' };

        var f = I.insertFileId(cur.text);
        var parsed2 = f.changed ? H.parseHttpFile(f.text, { fileName: String(path).split(/[\\/]/).pop() }) : cur.parsed;
        var target = parsed2.requests[idx];
        if (!target) return { ok: false, reason: 'NO_SEGMENT' };

        var i2 = I.insertInterfaceId(f.text, { line: target.line }, target.interfaceId || undefined);
        var next = i2.text;
        var ifaceId = i2.id || target.interfaceId || null;
        var fileId = f.id || parsed2.fileId || null;
        var changed = next !== cur.text;
        var mtime = cur.mtime;

        if (changed) {
          var w = await store.writeText(path, next, { baseMtime: cur.mtime });
          if (!w || !w.ok) {
            var why = (w && w.reason) || 'WRITE_FAILED';
            if (why === 'READONLY') return { ok: false, reason: 'READONLY', wrote: false };
            if (why === 'CONFLICT' && attempt < MAX_RETRY) { attempt++; continue; }
            return { ok: false, reason: why, wrote: false };
          }
          try {
            var st2 = await store.host.stat(path);
            mtime = Math.round((st2 && st2.modified) || 0);
          } catch (e) { /* 拿不到 mtime 不影响记历史 */ }
        }

        /* ---- 到这一步身份已经在磁盘上了（或本来就有），才开始写历史 ---- */
        if (!ifaceId) return { ok: false, reason: 'NO_ID' };

        var at = num(input.now) || Date.now();
        var entry = entryFor({
          at: at,
          response: resp,
          method: req.method || target.method,
          url: input.url || req.url || target.url,
          urlTemplate: req.url || target.url,
          interfaceId: ifaceId,
          fileId: fileId,
          file: String(path).split(/[\\/]/).pop(),
          name: req.name || target.name,
          resultPath: input.resultPath
        });

        var hp = historyPath(dir, path, ifaceId);
        var collection = collectionName(path);
        try { await store.host.ensureDir(S.dirName(hp)); } catch (e) { /* 写的时候还会再失败一次，由 append 报 */ }

        /* 资源目录第一次记历史时种一份 _history/_meta.json（已有就不动） */
        if (!metaTried[dir]) {
          metaTried[dir] = 1;
          try { await ensureMeta(store, dir); } catch (e) { /* 元数据缺失不影响记历史 */ }
        }

        /* 二进制：先把 body 挪到 .bin，jsonl 只留引用。写失败不挡历史，标 bodyOmitted。 */
        var b64 = input.bodyBase64 != null ? input.bodyBase64 : (resp.isBinary ? resp.text : '');
        var bin = null;
        if (b64 && (resp.isBinary || isBinaryContentType(resp.contentType))) {
          bin = await writeBody(store, dir, collection, ifaceId, at, b64, { maxBodyBytes: maxBody });
          if (bin.ok) {
            entry.bodyRef = bin.ref;
            entry.bodyEncoding = 'base64';
            entry.bodyBytes = bin.bytes;
          } else {
            entry.bodyOmitted = bin.reason;
            if (bin.bytes) entry.bodyBytes = bin.bytes;
          }
        }

        var line = JSON.stringify(entry) + '\n';
        var app = await serial(hp, function () { return appendEntry(store, hp, line, { max: maxLines }); });
        /* 身份索引：给 S4.6 的「按指纹找回旧 id」留候选，宿主列不出 _history/ 目录，只能自己记一份 */
        if (app.ok) {
          try { await noteIdentity(store, dir, collection, entry.fingerprint, ifaceId, at); } catch (e) { /* 索引坏了不影响历史 */ }
        }

        /* .gitignore 只补一次，失败静默（不影响调用，也不影响历史） */
        if (!giTried[dir]) {
          giTried[dir] = 1;
          try { await ensureGitignore(store, dir); } catch (e) { /* 忽略 */ }
        }

        return {
          ok: true,
          changed: changed,
          text: next,
          mtime: mtime,
          fileId: fileId,
          interfaceId: ifaceId,
          historyPath: hp,
          lines: app.ok ? app.lines : 0,
          historyWritten: !!app.ok,
          historyReason: app.ok ? null : (app.reason || 'WRITE_FAILED'),
          futureFormatVersion: app.formatVersion || 0,
          rotated: app.ok ? app.dropped : 0,
          bodyRef: entry.bodyRef || null,
          bodyBytes: entry.bodyBytes || 0,
          bodyOmitted: entry.bodyOmitted || null,
          assigned: !!i2.changed,           /* 这次才给这一段发的新身份（S4.6 的触发条件） */
          fingerprint: entry.fingerprint
        };
      }
      return { ok: false, reason: 'CONFLICT', wrote: false };
    }

    return {
      record: record,
      read: function (o) {
        o = o || {};
        return read({ store: o.store || opts.store, dir: o.dir || opts.dir, collection: o.collection, interfaceId: o.interfaceId, path: o.path });
      },
      rotate: function (p, m) { return rotateFile(opts.store, p, m == null ? maxLines : m); },
      ensureGitignore: function () { return ensureGitignore(opts.store, opts.dir); },
      dir: function () { return opts.dir; },
      maxLines: function () { return maxLines; }
    };
  }

  var api = {
    createHistory: createHistory,
    HISTORY_DIR: HISTORY_DIR,
    FORMAT_VERSION: FORMAT_VERSION,
    META_NAME: META_NAME,
    APP_ID: APP_ID,
    MAX_LINES: MAX_LINES,
    collectionName: collectionName,
    historyBase: historyBase,
    metaPath: metaPath,
    ensureMeta: ensureMeta,
    historyPath: historyPath,
    historyPathFor: historyPathFor,
    appendEntry: appendEntry,
    appendLine: appendEntry,          /* S4.2 的旧名字，语义已统一到 appendEntry */
    rotateText: rotateText,
    rotateFile: rotateFile,
    parseJsonl: parseJsonl,
    maxVersion: maxVersion,
    read: read,
    isBinaryContentType: isBinaryContentType,
    b64Bytes: b64Bytes,
    writeBody: writeBody,
    ensureGitignore: ensureGitignore,
    entryFor: entryFor,
    indexName: IDX_NAME,
    indexPath: indexPath,
    noteIdentity: noteIdentity,
    findByIdentity: findByIdentity,
    mergeInto: mergeInto,
    reuse: reuse
  };
  root.POLARIS_HISTORY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
