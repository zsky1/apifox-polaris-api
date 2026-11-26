/* http-store.js — 资源目录的真源层：一个 .http 文件就是一个 collection。
 *
 * 设计要点（见 docs/design-v1.0.0.md 第 2、3 节）：
 *   1. **文件是唯一真源**：扫目录就是全部 collection，没有索引文件、没有 storage 里的集合 JSON；
 *   2. **段落级替换**：改一个接口只重写它那一段，其它行的字节一个都不动（保住手写排版与注释）；
 *   3. **原子写**：先写 `<path>.tmp` 再 rename 覆盖，崩在中间也不会留下半个文件。
 *
 * 宿主访问全部走注入的 host，方便在 Node 里用 fs 跑单测：
 *   host.list(dir)                 -> { files: [{path,name,size,modified}] }
 *   host.read(path)                -> { content, name, dir }
 *   host.stat(path)                -> { exists, size, modified }   modified 为毫秒
 *   host.write(path, content)      -> { written }
 *   host.rename(from, to, opts)    -> { path }                     opts.overwrite
 *   host.remove(path)              -> { removed }
 *   host.ensureDir(dir)            -> { dir }
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;
  var tmpSeq = 0;   /* 原子写的 tmp 后缀，保证并发写不共用同一个临时文件 */

  function requireFile() {
    if (root.POLARIS_HTTP) return root.POLARIS_HTTP;
    if (typeof require === 'function') return require('./http-file.js');
    throw new Error('http-file.js 未加载');
  }

  /* ---------- 小工具 ---------- */

  function sepOf(p) { return String(p || '').indexOf('\\') >= 0 ? '\\' : '/'; }

  function joinPath(dir, name) {
    var d = String(dir || '').replace(/[\\/]+$/, '');
    if (!d) return String(name || '');
    return d + sepOf(d) + String(name || '');
  }

  function baseName(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function dirName(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i > 0 ? s.slice(0, i) : '';
  }

  /* collection 名 → 文件名：只替换操作系统不接受的字符，中文与空格原样保留 */
  function sanitizeName(name) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^[.\s]+/, '')
      .replace(/\s+$/, '')
      .slice(0, 80);
    return s || 'collection';
  }

  function stripExt(name) {
    return String(name || '').replace(/\.(http|rest)$/i, '');
  }

  /* 按文件自身的换行风格切行；返回 { eol, lines } */
  function splitLines(text) {
    var eol = /\r\n/.test(String(text)) ? '\r\n' : '\n';
    return { eol: eol, lines: String(text).split(/\r?\n/) };
  }

  function isDelimiter(line) { return /^#{3,}/.test(String(line).trim()); }

  /* 把 text 切成「段」：每段从一条 ### 开始，到下一段 ### 之前。
   * 第一个 ### 之前的内容（文件头注释 + @变量）算 preamble，不属于任何段。 */
  function segments(text) {
    var sp = splitLines(text);
    var marks = [];
    sp.lines.forEach(function (l, i) { if (isDelimiter(l)) marks.push(i); });
    var out = [];
    for (var k = 0; k < marks.length; k++) {
      out.push({ start: marks[k], end: k + 1 < marks.length ? marks[k + 1] - 1 : sp.lines.length - 1 });
    }
    return { eol: sp.eol, lines: sp.lines, marks: marks, segs: out };
  }

  /* 把解析出的请求映射到它的段下标。
   * 顺序：interfaceId（最稳）→ 行号 + 方法 → 方法/URL 唯一 → 方法/名称唯一。
   *
   * 关于行号：URL 允许被改（这正是写回的目的），所以只拿 method 一起核对，不比对 url；
   * 「文件是否被别人改过」交给 baseMtime 冲突检测兜底 —— 两者合起来才不会改错段。 */
  function locateSegment(parsed, req, geo) {
    if (!req) return -1;
    var rs = parsed.requests || [];
    var idx = -1;
    /* 方法一律按大写比对：调用方传 'post' 也要认出来 */
    var want = req.method ? String(req.method).toUpperCase() : '';

    if (req.interfaceId) {
      for (var i = 0; i < rs.length; i++) if (rs[i].interfaceId === req.interfaceId) { idx = i; break; }
      if (idx >= 0) return idx;
    }
    if (req.line) {
      for (var j = 0; j < rs.length; j++) {
        if (rs[j].line === req.line && (!want || rs[j].method === want)) { idx = j; break; }
      }
      if (idx >= 0) return idx;
    }
    if (want && req.url) {
      var hits = [];
      for (var k = 0; k < rs.length; k++) {
        if (rs[k].method === want && rs[k].url === req.url) hits.push(k);
      }
      if (hits.length === 1) return hits[0];
    }
    if (want && req.name) {
      var named = [];
      for (var m = 0; m < rs.length; m++) {
        if (rs[m].method === want && rs[m].name === req.name) named.push(m);
      }
      if (named.length === 1) return named[0];
    }
    return -1;
  }

  /* 请求所在段的下标：取「start <= 方法行」的最后一个段，且该段必须包含方法行 */
  function segIndexOfRequest(geo, req) {
    if (!req || !req.line) return -1;
    var line = req.line - 1;
    var best = -1;
    for (var i = 0; i < geo.segs.length; i++) {
      if (geo.segs[i].start <= line) best = i; else break;
    }
    if (best < 0) return -1;
    return geo.segs[best].end >= line ? best : -1;
  }

  /* 用新段替换旧段，保留该段末尾原有的空行数量，其余行原样保留。
   * seg 既可以是段下标，也可以是 {start,end}（单请求、无 ### 的文件没有段可数）。 */
  function replaceSegment(text, seg, blockLines) {
    var g = segments(text);
    if (typeof seg === 'number') seg = g.segs[seg];
    if (!seg) return null;

    var oldBlock = g.lines.slice(seg.start, seg.end + 1);
    var trailing = 0;
    for (var i = oldBlock.length - 1; i >= 0; i--) {
      if (oldBlock[i].trim() === '') trailing++; else break;
    }

    var fresh = blockLines.slice();
    while (fresh.length && fresh[fresh.length - 1].trim() === '') fresh.pop();
    for (var t = 0; t < trailing; t++) fresh.push('');

    var head = g.lines.slice(0, seg.start);
    var tail = g.lines.slice(seg.end + 1);
    return head.concat(fresh, tail).join(g.eol);
  }

  /* 整段搬移（S2.5d 拖拽排序）：把 fromLine 所在段整块搬到 beforeLine 所在段之前。
   *
   * 只重排「### 段」的顺序 —— 段的原始字节、文件头（preamble）、换行风格全部原样保留，
   * 不走 parse/serialize，所以注释、空行、手写排版一个字符都不会变。
   * beforeLine 省略（null）→ 搬到末尾。定位不到段或不足两段时返回 null，由调用方报 NOT_FOUND。 */
  function moveSegmentText(text, fromLine, beforeLine) {
    var t = String(text == null ? '' : text);
    var g = segments(t);
    if (g.marks.length < 2) return null;          /* 不到两段，没有可调的顺序 */

    /* 每个 ### 行的字符起始偏移：按偏移切原文，重排后拼接才逐字节不变 */
    var offs = [0];
    var re = /\r?\n/g, m;
    while ((m = re.exec(t))) offs.push(m.index + m[0].length);
    if (offs.length !== g.lines.length) return null;   /* 行数与偏移对不上（混合换行）：不冒险 */

    var cuts = g.marks.map(function (i) { return offs[i]; });
    var chunks = cuts.map(function (c, i) {
      return t.slice(c, i + 1 < cuts.length ? cuts[i + 1] : t.length);
    });
    var prefix = t.slice(0, cuts[0]);

    function segAt(line1) {
      if (!line1) return -1;
      var line = Math.max(0, Number(line1) - 1);
      for (var i = 0; i < g.marks.length; i++) {
        var end = i + 1 < g.marks.length ? g.marks[i + 1] - 1 : g.lines.length - 1;
        if (g.marks[i] <= line && line <= end) return i;
      }
      return -1;
    }

    var from = segAt(fromLine);
    if (from < 0) return null;
    var moved = chunks[from];
    var rest = chunks.slice(0, from).concat(chunks.slice(from + 1));

    var at;
    if (beforeLine == null || beforeLine === '') {
      at = rest.length;
    } else {
      var before = segAt(beforeLine);
      if (before < 0) return null;
      if (before === from) return t;            /* 拖回自己身上：什么都不做 */
      at = before > from ? before - 1 : before; /* 摘掉源段后目标下标会前移一位 */
    }
    rest.splice(at, 0, moved);
    return prefix + rest.join('');
  }

  /* ---------- 面向前端的宿主（走 sidecar） ---------- */

  function invokeHost(invoke) {
    function call(cmd, params) {
      return Promise.resolve(invoke(cmd, params || {}));
    }
    return {
      list: function (dir) { return call('http/listFiles', { dir: dir, recursive: false }); },
      read: function (p) { return call('http/readFile', { path: p }); },
      stat: function (p) { return call('http/statFile', { path: p }); },
      write: function (p, content) { return call('http/writeFile', { path: p, content: content }); },
      rename: function (from, to, opts) {
        return call('http/renameFile', { from: from, to: to, overwrite: !!(opts && opts.overwrite) });
      },
      remove: function (p) { return call('http/deleteFile', { path: p }); },
      ensureDir: function (dir) { return call('http/ensureDir', { dir: dir }); }
    };
  }

  /* ---------- store ---------- */

  function createStore(host, opts) {
    opts = opts || {};
    var dir = opts.dir || '';

    var store = {
      host: host,

      dir: function () { return dir; },
      setDir: function (d) { dir = String(d || ''); return dir; },

      /* 扫目录 → 每个 .http 一个 collection（含解析结果，侧栏与全局搜索直接用） */
      list: async function () {
        var H = requireFile();
        var res = await host.list(dir);
        var files = (res && res.files) || [];
        var out = [];
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          if (!/\.(http|rest)$/i.test(f.name || f.path)) continue;
          var item = {
            name: stripExt(f.name || baseName(f.path)),
            fileName: f.name || baseName(f.path),
            path: f.path,
            mtime: Math.round(f.modified || 0),
            size: f.size || 0,
            requests: [],
            warnings: [],
            error: null
          };
          try {
            var rd = await host.read(f.path);
            var parsed = H.parseHttpFile(rd.content, { fileName: item.fileName });
            item.requests = parsed.requests;
            item.warnings = parsed.warnings;
            item.fileId = parsed.fileId;
            item.fileVars = parsed.fileVars;
          } catch (e) {
            item.error = String((e && e.message) || e);
          }
          out.push(item);
        }
        out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
        return out;
      },

      read: async function (path) {
        var H = requireFile();
        var rd = await host.read(path);
        var st = await host.stat(path);
        var text = String(rd.content == null ? '' : rd.content);
        return {
          path: path,
          text: text,
          eol: /\r\n/.test(text) ? '\r\n' : '\n',
          mtime: Math.round((st && st.modified) || 0),
          parsed: H.parseHttpFile(text, { fileName: baseName(path) })
        };
      },

      /* 只读一个文件，返回与 list() 元素同构的 item。
       * 侧栏用它：映射登记了什么就读什么，**一个目录都不扫**。 */
      readOne: async function (path) {
        var H = requireFile();
        var rd = await host.read(path);
        var st = await host.stat(path);
        var text = String(rd.content == null ? '' : rd.content);
        var fileName = baseName(path);
        var item = {
          name: stripExt(fileName),
          fileName: fileName,
          path: path,
          mtime: Math.round((st && st.modified) || 0),
          size: text.length,
          requests: [],
          warnings: [],
          error: null
        };
        try {
          var parsed = H.parseHttpFile(text, { fileName: fileName });
          item.requests = parsed.requests;
          item.warnings = parsed.warnings;
          item.fileId = parsed.fileId;
          item.fileVars = parsed.fileVars;
        } catch (e) {
          item.error = String((e && e.message) || e);
        }
        return item;
      },

      /* 原子写：先 tmp 再 rename。baseMtime 给了就先比对，不一致直接 CONFLICT，不写任何东西。
       * tmp 名必须唯一：固定 `<path>.tmp` 时两次写撞在一起，后一个 rename 会找不到 tmp
       * （Windows 上还可能是「另一个进程正在使用」），workspace-map 那边踩过同一个坑。 */
      writeText: async function (path, text, o) {
        o = o || {};
        if (o.baseMtime != null) {
          var st = await host.stat(path);
          var now = Math.round((st && st.modified) || 0);
          if (st && st.exists && now !== Math.round(o.baseMtime)) {
            return { ok: false, reason: 'CONFLICT', current: now };
          }
        }
        tmpSeq = (tmpSeq + 1) % 100000;
        var tmp = path + '.' + tmpSeq + '-' + Date.now().toString(36) + '.tmp';
        try {
          await host.write(tmp, text);
        } catch (e) {
          return { ok: false, reason: 'READONLY', error: String((e && e.message) || e) };
        }
        try {
          await host.rename(tmp, path, { overwrite: true });
        } catch (e) {
          try { await host.remove(tmp); } catch (e2) { /* 清不掉就留着，不阻塞 */ }
          return { ok: false, reason: 'WRITE_FAILED', error: String((e && e.message) || e) };
        }
        return { ok: true };
      },

      /* 段落级写回。req 需要能定位到段：给 interfaceId，或给 line + method + url。
       * o.interfaceId —— 顺带把身份行补进这一段（首次发请求 / 接回旧身份时用） */
      writeRequest: async function (path, req, o) {
        o = o || {};
        var H = requireFile();
        var cur;
        try {
          cur = await store.read(path);
        } catch (e) {
          return { ok: false, reason: 'NOT_FOUND', error: String((e && e.message) || e) };
        }
        if (o.baseMtime != null && cur.mtime !== Math.round(o.baseMtime)) {
          return { ok: false, reason: 'CONFLICT', current: cur.mtime };
        }

        var geo = segments(cur.text);
        var reqIndex = locateSegment(cur.parsed, req, geo);
        if (reqIndex < 0) return { ok: false, reason: 'NOT_FOUND' };

        var target = cur.parsed.requests[reqIndex];
        var segIndex = segIndexOfRequest(geo, target);
        var seg = segIndex >= 0
          ? geo.segs[segIndex]
          : (cur.parsed.requests.length === 1 ? { start: Math.max(0, target.line - 1), end: geo.lines.length - 1 } : null);
        if (!seg) return { ok: false, reason: 'NOT_FOUND' };
        var merged = {
          /* title 显式给了就改（侧栏重命名走这条路），没给就沿用文件里的 ### 标题 */
          title: req.title != null ? req.title : (target.title || ''),
          name: req.name || target.name,
          method: req.method || target.method,
          url: req.url != null ? req.url : target.url,
          headers: req.headers || target.headers,
          body: req.body != null ? req.body : target.body,
          bodyType: req.bodyType || target.bodyType,
          bodyFromFile: req.bodyFromFile != null ? req.bodyFromFile : target.bodyFromFile,
          outputFile: req.outputFile != null ? req.outputFile : target.outputFile,
          preScript: req.preScript != null ? req.preScript : target.preScript,
          postScript: req.postScript != null ? req.postScript : target.postScript,
          interfaceId: o.interfaceId || target.interfaceId || req.interfaceId || null
        };

        var block = H.serializeRequest(merged, { eol: cur.eol });
        var next = replaceSegment(cur.text, seg, block.split(/\r?\n/));
        if (next == null) return { ok: false, reason: 'NOT_FOUND' };

        var w = await store.writeText(path, next, { baseMtime: cur.mtime });
        if (!w.ok) return w;
        return { ok: true, segment: segIndex, interfaceId: merged.interfaceId || null, path: path };
      },

      /* 在文件末尾追加一段（「保存请求」落到某个 collection 时用）。
       * 原有内容逐字节保留，唯一被规范化的是文件末尾的多余空行：
       * 追加前先压掉尾部空行，再用一个空行把新段隔开，文件以单个换行收尾。 */
      /* 同文件内调请求顺序：整段搬移，段内字节不动（跨文件搬段不在这一步做）。 */
      moveSegment: async function (path, fromLine, beforeLine, o) {
        o = o || {};
        var cur;
        try {
          cur = await store.read(path);
        } catch (e) {
          return { ok: false, reason: 'NOT_FOUND', error: String((e && e.message) || e) };
        }
        if (o.baseMtime != null && cur.mtime !== Math.round(o.baseMtime)) {
          return { ok: false, reason: 'CONFLICT', current: cur.mtime };
        }
        var next = moveSegmentText(cur.text, fromLine, beforeLine);
        if (next == null) return { ok: false, reason: 'NOT_FOUND' };
        if (next === cur.text) return { ok: true, moved: false, path: path };
        var w = await store.writeText(path, next, { baseMtime: cur.mtime });
        if (!w.ok) return w;
        return { ok: true, moved: true, path: path };
      },

      appendRequest: async function (path, req, o) {
        o = o || {};
        var H = requireFile();
        var cur;
        try {
          cur = await store.read(path);
        } catch (e) {
          return { ok: false, reason: 'NOT_FOUND', error: String((e && e.message) || e) };
        }
        if (o.baseMtime != null && cur.mtime !== Math.round(o.baseMtime)) {
          return { ok: false, reason: 'CONFLICT', current: cur.mtime };
        }
        var merged = {
          title: req.title || req.name || '',
          name: req.name || req.title || '',
          method: String(req.method || 'GET').toUpperCase(),
          url: req.url || '',
          headers: req.headers || [],
          body: req.body == null ? '' : String(req.body),
          bodyType: req.bodyType || 'text',
          bodyFromFile: req.bodyFromFile || null,
          outputFile: req.outputFile || null,
          preScript: req.preScript || null,
          postScript: req.postScript || null,
          interfaceId: o.interfaceId || req.interfaceId || null
        };
        var block = H.serializeRequest(merged, { eol: cur.eol }).split(/\r?\n/);
        var sp = splitLines(cur.text);
        var lines = sp.lines.slice();
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        var next = (lines.length ? lines.join(sp.eol) + sp.eol + sp.eol : '') + block.join(sp.eol) + sp.eol;

        var w = await store.writeText(path, next, { baseMtime: cur.mtime });
        if (!w.ok) return w;
        return { ok: true, path: path, index: (cur.parsed.requests || []).length, interfaceId: merged.interfaceId || null };
      },

      /* 删掉某一段（侧栏的「删除请求」）。只摘掉这一段的行，其余行原样拼接。 */
      deleteRequest: async function (path, req, o) {
        o = o || {};
        var cur;
        try {
          cur = await store.read(path);
        } catch (e) {
          return { ok: false, reason: 'NOT_FOUND', error: String((e && e.message) || e) };
        }
        if (o.baseMtime != null && cur.mtime !== Math.round(o.baseMtime)) {
          return { ok: false, reason: 'CONFLICT', current: cur.mtime };
        }
        var geo = segments(cur.text);
        var reqIndex = locateSegment(cur.parsed, req, geo);
        if (reqIndex < 0) return { ok: false, reason: 'NOT_FOUND' };

        var target = cur.parsed.requests[reqIndex];
        var segIndex = segIndexOfRequest(geo, target);
        var seg = segIndex >= 0
          ? geo.segs[segIndex]
          : (cur.parsed.requests.length === 1 ? { start: Math.max(0, target.line - 1), end: geo.lines.length - 1 } : null);
        if (!seg) return { ok: false, reason: 'NOT_FOUND' };

        var lines = geo.lines.slice(0, seg.start).concat(geo.lines.slice(seg.end + 1));
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        var next = lines.length ? lines.join(geo.eol) + geo.eol : '';

        var w = await store.writeText(path, next, { baseMtime: cur.mtime });
        if (!w.ok) return w;
        return { ok: true, path: path, segment: segIndex };
      },

      createCollection: async function (name) {
        var safe = sanitizeName(name);
        var target = joinPath(dir, /\.(http|rest)$/i.test(safe) ? safe : safe + '.http');
        var st = await host.stat(target);
        if (st && st.exists) return { ok: false, reason: 'EXISTS', path: target };
        var text = '# ' + stripExt(baseName(target)) + '\n';
        var w = await store.writeText(target, text, {});
        if (!w.ok) return w;
        return { ok: true, path: target, name: stripExt(baseName(target)) };
      },

      renameCollection: async function (path, newName) {
        var safe = sanitizeName(newName);
        var target = joinPath(dirName(path) || dir, /\.(http|rest)$/i.test(safe) ? safe : safe + '.http');
        if (target === path) return { ok: true, path: path };
        var st = await host.stat(target);
        if (st && st.exists) return { ok: false, reason: 'EXISTS', path: target };
        try {
          /* 保留原扩展名，避免 .rest 被改成 .http */
          var ext = /\.(http|rest)$/i.exec(path);
          if (ext) target = target.replace(/\.(http|rest)$/i, '.' + ext[1]);
          await host.rename(path, target, { overwrite: false });
        } catch (e) {
          return { ok: false, reason: 'RENAME_FAILED', error: String((e && e.message) || e) };
        }
        return { ok: true, path: target, name: stripExt(baseName(target)) };
      },

      deleteCollection: async function (path) {
        try {
          await host.remove(path);
        } catch (e) {
          return { ok: false, reason: 'DELETE_FAILED', error: String((e && e.message) || e) };
        }
        return { ok: true };
      }
    };

    return store;
  }

  /* ---------- 旧数据迁移（storage 里的 collections JSON → 一个 collection 一个文件） ---------- */

  /* 0.6.x 的 tab/请求模型 → .http 里能表达的形状。
   * 取舍说明：
   *   - 参数行（params）折进 URL 的查询串，否则这部分数据会凭空消失；不额外编码，避免二次转义；
   *   - bodyType 为 json / form 且没写 Content-Type 时补一条，否则解析回来会退化成 text，
   *     下次保存就把用户的内容当纯文本处理了；
   *   - 其余字段原样搬，不重排、不改写。 */
  function mirrorRequest(r) {
    var url = String((r && r.url) || '');
    var qs = ((r && r.params) || [])
      .filter(function (p) { return p && p.on !== false && String(p.k || '').trim(); })
      .map(function (p) { return String(p.k).trim() + '=' + (p.v == null ? '' : String(p.v)); })
      .join('&');
    if (qs) url += (url.indexOf('?') < 0 ? '?' : '&') + qs;

    var headers = ((r && r.headers) || [])
      .filter(function (h) { return h && h.on !== false && String(h.k || '').trim(); })
      .map(function (h) { return { k: String(h.k).trim(), v: h.v == null ? '' : String(h.v) }; });

    var body = r && r.body != null ? String(r.body) : '';
    var bt = (r && r.bodyType) || 'none';
    var hasCt = headers.some(function (h) { return /^content-type$/i.test(h.k); });
    if (!hasCt && bt === 'json') headers.push({ k: 'Content-Type', v: 'application/json' });
    if (!hasCt && bt === 'form') headers.push({ k: 'Content-Type', v: 'application/x-www-form-urlencoded' });
    if (bt === 'form' && !body) {
      body = ((r && r.formBody) || [])
        .filter(function (p) { return p && p.on !== false && String(p.k || '').trim(); })
        .map(function (p) { return String(p.k).trim() + '=' + (p.v == null ? '' : String(p.v)); })
        .join('&');
    }

    return {
      title: (r && r.name) || '',
      name: (r && r.name) || '',
      method: String((r && r.method) || 'GET').toUpperCase(),
      url: url,
      headers: headers,
      body: body,
      bodyType: bt
    };
  }

  /* 幂等迁移：目标文件已存在就**不覆盖**，把旧 JSON 原样留档到 `.apifox-migrate/`。
   * 返回 { created, skipped, archived }，调用方据此决定是否提示用户。 */
  async function migrateFromStorage(store, collections, opts) {
    opts = opts || {};
    var H = requireFile();
    var out = { created: [], skipped: [], archived: [] };
    var list = Array.isArray(collections) ? collections : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i] || {};
      var name = sanitizeName(c.name || ('collection-' + (i + 1)));
      var target = joinPath(store.dir(), name + '.http');
      var st = await store.host.stat(target);
      if (st && st.exists) {
        var adir = joinPath(store.dir(), '.apifox-migrate');
        await store.host.ensureDir(adir);
        var apath = joinPath(adir, name + '.json');
        await store.host.write(apath, JSON.stringify(c, null, 2));
        out.skipped.push(target);
        out.archived.push(apath);
        continue;
      }
      var doc = {
        fileVars: {},
        requests: ((c.requests) || []).map(mirrorRequest)
      };
      var text = H.serializeCollection(doc, {
        header: '# ' + (c.name || name) + '\n# 从 0.6.x 的 storage 迁移而来，可自由改动'
      });
      var w = await store.writeText(target, text, {});
      if (w.ok) out.created.push(target); else { out.skipped.push(target); out.error = w.reason; }
    }
    return out;
  }

  /* ---------- 文件 → 侧栏/表单用的旧形状（S1.5 的投影层） ----------
   * 侧栏与请求编辑器现在吃的是 state.collections 那套形状（group.requests[] 带 headers 行 id）。
   * 与其重写整棵 UI，不如把文件解析结果投影成同一形状：渲染代码不动，数据源换成磁盘。
   * id 用「路径 + 行号」：路径跨会话稳定；行号只在同一份快照内用，写回时由 store 重新定位。 */
  function toLegacyCollections(list, opts) {
    opts = opts || {};
    var blankRow = opts.blankRow || function () { return { id: 'r' + Math.random().toString(36).slice(2, 8), on: true, k: '', v: '' }; };
    var rowId = function () { return 'r' + Math.random().toString(36).slice(2, 8); };
    var bodyTypeMap = { json: 'json', form: 'form', none: 'none', multipart: 'multipart' };

    return (list || []).map(function (c) {
      var group = {
        id: c.path,
        name: c.name,
        path: c.path,
        fileId: c.fileId || null,
        fileVars: c.fileVars || {},
        mtime: c.mtime || 0,
        collapsed: false,
        error: c.error || null,
        requests: (c.requests || []).map(function (r) {
          var formBody = [blankRow()];
          if (r.bodyType === 'form' && r.body) {
            formBody = String(r.body).split('&').map(function (kv) {
              var i = kv.indexOf('=');
              return { id: rowId(), on: true, k: i < 0 ? kv : kv.slice(0, i), v: i < 0 ? '' : kv.slice(i + 1) };
            });
            formBody.push(blankRow());
          }
          /* multipart 的分段直接取自解析结果（parseHttpFile 已经切好了），
           * 不再二次解析 body 文本 —— 两边用同一份事实，少一次走样机会。 */
          var mpParts = [];
          var mpBoundary = '';
          if (bodyTypeMap[r.bodyType] === 'multipart') {
            mpBoundary = (r.multipart && r.multipart.boundary) || '';
            mpParts = ((r.multipart && r.multipart.parts) || []).map(function (p) {
              var isFile = !!p.filePath;
              return {
                id: rowId(), on: true, name: p.name || '',
                kind: isFile ? 'file' : 'text',
                v: isFile ? p.filePath : (p.content || ''),
                filename: p.filename || (isFile ? baseName(p.filePath) : ''),
                contentType: p.contentType || ''
              };
            });
          }
          return {
            id: r.interfaceId || (c.path + '#' + r.line),
            interfaceId: r.interfaceId || null,
            name: r.title || r.name,
            method: r.method,
            url: r.url,
            params: [blankRow()],
            headers: (r.headers || []).map(function (h) { return { id: rowId(), on: true, k: h.k, v: h.v }; }).concat([blankRow()]),
            bodyType: bodyTypeMap[r.bodyType] || 'text',
            body: r.body || '',
            formBody: formBody,
            mpParts: mpParts,
            mpBoundary: mpBoundary,
            httpSource: {
              file: c.path,
              fileName: c.fileName,
              line: r.line,
              name: r.name,
              interfaceId: r.interfaceId || null,
              mtime: c.mtime || 0
            }
          };
        })
      };
      return group;
    });
  }

  var api = {
    createStore: createStore,
    invokeHost: invokeHost,
    toLegacyCollections: toLegacyCollections,
    migrateFromStorage: migrateFromStorage,
    mirrorRequest: mirrorRequest,
    sanitizeName: sanitizeName,
    joinPath: joinPath,
    baseName: baseName,
    dirName: dirName,
    segments: segments,
    replaceSegment: replaceSegment,
    moveSegmentText: moveSegmentText,
    locateSegment: locateSegment,
    segIndexOfRequest: segIndexOfRequest,
    splitLines: splitLines
  };
  root.POLARIS_STORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
