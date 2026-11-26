/* http-file.js — IntelliJ IDEA HTTP Client (.http / .rest) 文件解析与变量求值。
 *
 * 纯函数，无 DOM / 无宿主依赖；IIFE 挂 window.POLARIS_HTTP。
 * 与 curl.js 同风格，可被 Node 直接 require 做单元测试（见 tools/http-file.test.mjs）。
 *
 * 支持的语法子集（v0.3.0）：
 *   ### 分隔请求（### 名称 / # @name 名称）
 *   @name = value 文件级变量、{{name}} 插值
 *   http-client.env.json / http-client.private.env.json 环境变量（由 sidecar 读取后传入）
 *   请求行 METHOD URL [HTTP/1.1]、Header: Value、空行后 Body
 *   < ./body.json 整包 body 来自文件、> ./out.json 响应另存
 *   multipart/form-data：直接写 --boundary 分段，段内 `< 附件路径` 表示该段为二进制文件
 *   > {% ... %} 响应脚本、{% ... %} 预请求脚本、client.test 断言（解析并保留，暂不执行）
 *   跨请求引用 {{login.response.body.$.token}} / {{login.response.headers.x-token}}
 *   内置动态变量 {{$guid}} {{$timestamp}} {{$randomInt}} {{$datetimeIso}}
 *
 * 明确不支持：脚本实际执行、client.global、multipart 的 `<>` 简写、GraphQL 专用块、
 * WebSocket / gRPC 请求、>< 比较断言。解析时给出 warnings，不静默丢弃。
 */
(function () {
  var root = typeof window !== 'undefined' ? window : globalThis;

  /* WEBSOCKET 是 IntelliJ 的写法，WS / WSS 是常见简写，解析时统一归一成 WEBSOCKET。
   * 它不是 HTTP 方法（没有语义上的请求行/状态行），但**共用同一条请求行语法**：
   *   WEBSOCKET ws://host/path
   *   Header: value
   *
   *   {"op":"sub"}          ← 空行之后是「连上后要发的第一条消息」
   * 所以放在方法表里最省事：位置、高亮、写回、身份、历史全部复用，不用另开一套结构。 */
  var METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'WEBSOCKET'];
  var METHOD_RE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|WEBSOCKET|WSS|WS)\s+(.+?)(?:\s+HTTP\/\d(?:\.\d)?)?\s*$/i;
  var pendingPreScript = null;

  function trimRight(s) { return String(s).replace(/\s+$/, ''); }
  function safeName(s, fallback) {
    var t = String(s || '').trim().replace(/[^0-9A-Za-z_\-\u4e00-\u9fa5.]+/g, '_').slice(0, 60);
    return t || fallback;
  }

  /* ---- multipart/form-data 体解析 ----
   * 形如：
   *   --WebAppBoundary
   *   Content-Disposition: form-data; name="audio"; filename="a.wav"
   *   Content-Type: audio/wav
   *
   *   < D:\path\a.wav
   *   --WebAppBoundary--
   * 分段内容可以是文本，也可以是 `< 文件路径`（二进制附件，由 UI 读成字节拼装）。
   * 兼容「分段头与内容之间没有空行」的写法（IDEA 允许，很多人也这么写）。 */
  function parseMultipart(text, boundary) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var B = String(boundary || '').trim();
    if (!B) {
      for (var i0 = 0; i0 < lines.length; i0++) {
        var t0 = lines[i0].trim();
        if (!t0) continue;
        if (/^--\S+$/.test(t0)) B = t0.replace(/^--/, '').replace(/--$/, '');
        break;
      }
    }
    var open = '--' + B;
    var parts = [];
    var inPart = false;
    var buf = [];

    function flush() {
      if (!inPart) return;
      var hs = [], idx = 0, k;
      /* 头部行必须是合法的 HTTP 头名（去掉 `< path` 这种内容行） */
      var TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
      for (; idx < buf.length; idx++) {
        var L = buf[idx];
        if (L.trim() === '') { idx++; break; }
        var ci = L.indexOf(':');
        var name = ci > 0 ? L.slice(0, ci) : '';
        if (ci > 0 && TOKEN.test(name)) {
          hs.push({ k: name.trim(), v: L.slice(ci + 1).trim() });
          continue;
        }
        break;
      }
      var contentLines = buf.slice(idx);
      while (contentLines.length && contentLines[0].trim() === '') contentLines.shift();
      while (contentLines.length && contentLines[contentLines.length - 1].trim() === '') contentLines.pop();

      var filePath = null;
      var content = contentLines.join('\n');
      if (contentLines.length === 1) {
        var fm = /^<\s+(.+)$/.exec(contentLines[0].trim());
        if (fm) { filePath = fm[1].trim(); content = ''; }
      }
      var cd = '';
      for (k = 0; k < hs.length; k++) if (/^content-disposition$/i.test(hs[k].k)) cd = hs[k].v;
      var nm = /name\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
      var fn = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
      var pct = '';
      for (k = 0; k < hs.length; k++) if (/^content-type$/i.test(hs[k].k)) pct = hs[k].v;
      parts.push({
        headers: hs,
        name: nm ? (nm[1] != null ? nm[1] : nm[2] || '').trim() : '',
        filename: fn ? (fn[1] != null ? fn[1] : fn[2] || '').trim() : '',
        contentType: pct,
        content: content,
        filePath: filePath
      });
      inPart = false;
      buf = [];
    }

    for (var j = 0; j < lines.length; j++) {
      var t = lines[j].trim();
      if (t === open) { flush(); inPart = true; buf = []; continue; }
      if (t === open + '--') { flush(); break; }
      if (inPart) buf.push(lines[j]);
    }
    flush();

    return {
      boundary: B,
      parts: parts,
      contentType: 'multipart/form-data; boundary=' + B
    };
  }

  /* ---- multipart 表单模型（表单编辑器 ⇄ .http 源码）----
   * 表单里的「一行」就是一个分段：
   *   文本段 → Content-Disposition + 空行 + 值
   *   文件段 → Content-Disposition(filename) + Content-Type + 空行 + `< 路径`
   * 这一层只做结构 ⇄ 文本，**不读文件**（读文件是发送时的事）。
   * 之所以要双向：.http 仍是唯一真源，表单只是同一段文字的另一种视图。 */

  function mpBaseName(p) {
    var s = String(p || '');
    var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  var MP_MIME = {
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    flac: 'audio/flac', amr: 'audio/amr',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', svg: 'image/svg+xml',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
    json: 'application/json', xml: 'application/xml', txt: 'text/plain', csv: 'text/csv',
    mp4: 'video/mp4', mov: 'video/quicktime'
  };
  function mpMime(name) {
    var m = /\.([A-Za-z0-9]+)\s*$/.exec(String(name || ''));
    return (m && MP_MIME[m[1].toLowerCase()]) || 'application/octet-stream';
  }

  /* boundary 从 header 的 Content-Type 里取；没有就看 body 第一个 --xxx；都没有交给调用方兜底。 */
  function guessBoundary(headers, body) {
    var hs = headers || [];
    for (var i = 0; i < hs.length; i++) {
      var h = hs[i];
      if (h && /^content-type$/i.test(h.k || '') && /multipart\//i.test(h.v || '')) {
        var m = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(h.v);
        if (m) return String(m[1] != null ? m[1] : m[2] || '').trim().replace(/^"|"$/g, '');
      }
    }
    var lines = String(body || '').split(/\r?\n/);
    for (var j = 0; j < lines.length; j++) {
      var t = lines[j].trim();
      if (!t) continue;
      if (/^--\S+/.test(t)) return t.replace(/^--/, '').replace(/--$/, '');
      break;
    }
    return '';
  }

  /* parts → body 文本。字段名里的 `"` 折成 `'`（RFC 7578 的 filename 同理），
   * 跟发送侧 buildMultipart 的转义保持同一套规则，避免「看着一样、发出去不一样」。 */
  function mpToBody(parts, boundary) {
    var B = String(boundary || '').trim() || 'ApifoxBoundary';
    var out = [];
    (parts || []).forEach(function (p) {
      if (!p || p.on === false) return;
      var name = String(p.name || '').trim();
      var isFile = p.kind === 'file';
      var val = p.v == null ? '' : String(p.v);
      if (!name && !val) return;
      if (!name) name = 'field';
      out.push('--' + B);
      var cd = 'Content-Disposition: form-data; name="' + name.replace(/"/g, "'") + '"';
      if (isFile) {
        var fn = p.filename || mpBaseName(val);
        if (fn) cd += '; filename="' + String(fn).replace(/"/g, "'") + '"';
      }
      out.push(cd);
      if (isFile) {
        var ct = p.contentType || mpMime(p.filename || val);
        if (ct) out.push('Content-Type: ' + ct);
        out.push('');
        out.push('< ' + val);
      } else {
        out.push('');
        val.split(/\r?\n/).forEach(function (l) { out.push(l); });
      }
    });
    out.push('--' + B + '--');
    return out.join('\n');
  }

  /* body 文本 → parts（表单行）。filePath 有值就是文件段，否则按文本段。 */
  function mpFromBody(body, boundary, mkId) {
    var B = String(boundary || '').trim() || guessBoundary(null, body) || 'ApifoxBoundary';
    var mp = parseMultipart(body, B);
    var n = 0;
    return (mp.parts || []).map(function (p) {
      var isFile = !!p.filePath;
      n += 1;
      return {
        id: mkId ? mkId(n) : 'mp' + n,
        on: true,
        name: p.name || '',
        kind: isFile ? 'file' : 'text',
        v: isFile ? p.filePath : (p.content || ''),
        filename: p.filename || (isFile ? mpBaseName(p.filePath) : ''),
        contentType: p.contentType || ''
      };
    });
  }

  /* ---- 身份注释（wpa 扩展，仍然是普通 # 注释）----
   *   # @file_id 7f3a9c21  wpa 文件身份，用于关联本 collection 的历史目录
   *   # @interface_id a1b2c3d4  wpa 接口身份，用于关联调用历史
   *
   * 两条硬规则：
   *   1. 只取 id 后第一个 token，行尾说明一律丢弃 —— 否则第二次读回来 id 会带上整句话；
   *   2. @file_id 必须写在第一个 ### 之前，写在段落里会被归给该段，这里显式告警并忽略。
   * 短横线与下划线等价（@file-id / @file_id 都认）。 */
  var ID_LINE_RE = /^#\s*@(file|interface)[_-]id(?:\s+(.*))?$/i;
  var ID_VALUE_RE = /^[A-Za-z0-9_-]{4,32}$/;

  /* 序列化时统一使用的行尾说明（解析时丢弃，写回时按模板重建） */
  var ID_NOTE = {
    file: 'wpa 文件身份，用于关联本 collection 的历史目录',
    interface: 'wpa 接口身份，用于关联调用历史'
  };

  /* 解析一个 .http 文件。
   * opts: { fileName, variables }
   * 返回 { fileName, fileId, fileIdLine, variables, requests, warnings }
   * request: { id, interfaceId, interfaceIdLine, name, method, url, headers:[{k,v}], body, bodyType,
   *            bodyFromFile, outputFile, preScript, postScript, tests, raw, line, sourceFile }
   *
   * 注意 id 与 interfaceId 的区别：
   *   id          —— 解析序号（http-1、http-2），只在本进程内有效，不落盘；
   *   interfaceId —— 文件里 # @interface_id 的值，落盘、跨会话稳定，历史按它归档。 */
  function parseHttpFile(text, opts) {
    opts = opts || {};
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var variables = Object.assign({}, opts.variables || {});
    var fileVars = {};          /* 只含文件里写出来的 @变量，序列化用这个，别把环境变量写进文件 */
    var requests = [];
    var warnings = [];
    var sourceFile = opts.fileName || '';
    var fileId;
    var fileIdLine;
    var sawDelimiter = false;
    var pendingInterfaceId = null;
    var pendingInterfaceIdLine = 0;
    pendingPreScript = null;

    var cur = null;
    var phase = 'idle';          // idle | headers | body | preScript | postScript
    var bodyBuf = [];
    var scriptBuf = [];
    var scriptKind = null;
    var pendingName = null;
    var pendingTitle = null;   /* ### 后的标题：@name 只用来做引用键，展示仍用标题 */
    var seq = 0;

    function finish() {
      if (!cur) return;
      if (bodyBuf.length) cur.body = bodyBuf.join('\n').replace(/\n+$/, '');
      /* WebSocket：空行之后是「连上就发」的第一条消息；多条消息用 `===` 分隔
       * （IntelliJ 2021.3+ 的写法，`=== 名称` 允许带标题）。
       * body 保留第一条 —— 写回文件、跨请求引用、历史都按它走，不另立真源。 */
      if (cur.isWs) {
        var chunks = String(cur.body || '').split(/\n[ \t]*={3,}[^\n]*\n?/);
        var msgs = [];
        for (var ci = 0; ci < chunks.length; ci++) {
          var one = chunks[ci].replace(/^\n+/, '').replace(/\n+$/, '');
          if (one !== '') msgs.push(one);
        }
        cur.wsMessages = msgs;
        cur.body = msgs.length ? msgs[0] : '';
        if (!msgs.length) {
          warnings.push('WebSocket 请求「' + (cur.name || cur.url) + '」没有首条消息：连上后只等对端推送');
        } else if (msgs.length > 1) {
          warnings.push('WebSocket 请求「' + (cur.name || cur.url) + '」有 ' + msgs.length + ' 条消息（=== 分隔），连上后先发第 1 条，其余可在消息面板逐条发');
        }
      }
      if (scriptBuf.length) {
        var s = scriptBuf.join('\n').trim();
        if (scriptKind === 'pre') cur.preScript = s; else cur.postScript = s;
      }
      var testHits = cur.postScript.match(/client\.test\s*\(/g);
      if (testHits) cur.tests += testHits.length;
      if (!cur.name) {
        cur.name = (cur.method + ' ' + (cur.url || '未命名请求')).slice(0, 48);
        cur.nameAuto = true;      /* 没有标题：侧栏改用 URL 末两段显示 */
      } else {
        cur.nameAuto = false;
      }
      if (!cur.bodyType) {
        var ctH = (cur.headers || []).find(function (h) { return /^content-type$/i.test(h.k); });
        var ctV = ctH ? String(ctH.v || '') : '';
        var bnd = (/(?:^|;)\s*boundary\s*=\s*"?([^";]+)"?/i.exec(ctV) || [])[1] || '';
        /* multipart：Content-Type 声明了 multipart，或 body 首行就是 --boundary */
        if (/multipart\//i.test(ctV) || /^\s*--[^\s-]/.test(cur.body || '')) {
          cur.bodyType = 'multipart';
          cur.multipart = parseMultipart(cur.body, bnd);
          if (!cur.multipart.parts.length) {
            warnings.push('请求「' + cur.name + '」声明为 multipart 但没解析出任何分段，检查 --boundary 是否与 Content-Type 一致');
          }
          var lackCt = !ctH;
          if (lackCt) {
            cur.headers.push({ k: 'Content-Type', v: cur.multipart.contentType });
            warnings.push('请求「' + cur.name + '」缺少 Content-Type，已按 body 里的 boundary 自动补上');
          } else if (bnd && bnd !== cur.multipart.boundary) {
            warnings.push('请求「' + cur.name + '」body 里的 boundary 与 Content-Type 不一致，发送时以 body 为准');
          }
        } else if (cur.bodyFromFile) {
          cur.bodyType = /\.json$/i.test(cur.bodyFromFile) ? 'json' : 'file';
        } else if (ctV && /json/i.test(ctV)) cur.bodyType = 'json';
        else if (ctV && /x-www-form-urlencoded/i.test(ctV)) cur.bodyType = 'form';
        else if (cur.body) cur.bodyType = 'text';
        else cur.bodyType = 'none';
      }
      if (cur.tests) warnings.push('请求「' + cur.name + '」含 ' + cur.tests + ' 个 client.test 断言，v0.3.0 仅解析不执行');
      if (cur.preScript) warnings.push('请求「' + cur.name + '」含预请求脚本，v0.3.0 仅解析不执行');
      if (cur.postScript) warnings.push('请求「' + cur.name + '」含响应脚本，v0.3.0 仅解析不执行');
      cur.raw = (cur.rawLines || []).join('\n');
      delete cur.rawLines;
      requests.push(cur);
      cur = null;
    }

    function startRequest(line, lineNo) {
      seq += 1;
      var method = String(line.method || '').toUpperCase();
      var isWs = method === 'WEBSOCKET';
      cur = {
        id: 'http-' + seq,
        interfaceId: pendingInterfaceId || undefined,
        interfaceIdLine: pendingInterfaceIdLine || undefined,
        name: pendingName || '',
        title: pendingTitle || '',
        method: method,
        isWs: isWs,
        url: trimRight(line.url),
        headers: [],
        body: '',
        wsMessages: isWs ? [] : undefined,
        bodyType: '',
        bodyFromFile: null,
        outputFile: null,
        preScript: '',
        postScript: '',
        tests: 0,
        line: lineNo,
        sourceFile: sourceFile
      };
      cur.rawLines = [];
      pendingName = null;
      pendingTitle = null;
      pendingInterfaceId = null;
      pendingInterfaceIdLine = 0;
      phase = 'headers';
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = trimRight(raw);
      var trimmed = line.trim();
      var lineNo = i + 1;

      /* --- 请求分隔：连续 3 个及以上 # ---
       * 标题判定 = 「3 个以上的 #」+「空格」+「后面的内容」；
       * ###/####/#####…乃至 N 个 # 都算，4 个不是「3 个的子集」而是同样合法。
       * 只有 #（后面没空格没内容）→ 只是分隔线，不产生标题。 */
      if (/^#{3,}/.test(trimmed)) {
        finish();
        bodyBuf = []; scriptBuf = []; scriptKind = null;
        sawDelimiter = true;
        var tm = /^#{3,}[ \t]+(.+)$/.exec(trimmed);
        var nm = tm ? tm[1].trim() : '';
        if (nm) { pendingName = nm; pendingTitle = nm; }
        phase = 'idle';
        continue;
      }

      /* --- 脚本块收集（> {% ... %} / {% ... %}） --- */
      if (phase === 'preScript' || phase === 'postScript') {
        scriptBuf.push(raw);
        if (trimmed.indexOf('%}') >= 0) {
          var joined = scriptBuf.join('\n').trim();
          if (scriptKind === 'pre') {
            if (cur) cur.preScript = joined;
            else { pendingPreScript = pendingPreScript || []; pendingPreScript.push(joined); }
          } else if (cur) {
            cur.postScript = joined;
          }
          scriptBuf = [];
          phase = cur ? (bodyBuf.length ? 'body' : 'headers') : 'idle';
        }
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* 单行完整脚本 > {% ... %} */
      if (/^>\s*\{%/.test(trimmed)) {
        if (trimmed.indexOf('%}') >= 0) {
          if (cur) cur.postScript = trimmed;
          else warnings.push('第 ' + lineNo + ' 行的响应脚本在任何请求之外，已忽略');
        } else {
          scriptKind = 'post'; scriptBuf = [raw]; phase = 'postScript';
        }
        if (cur) cur.rawLines.push(raw);
        continue;
      }
      if (/^\{%/.test(trimmed) && !cur) {
        if (trimmed.indexOf('%}') >= 0) {
          // 预请求脚本位于第一个请求之前，挂到下一个请求上
          pendingName = pendingName || '';
          if (!pendingPreScript) pendingPreScript = [];
          pendingPreScript.push(trimmed);
        } else {
          scriptKind = 'pre'; scriptBuf = [raw]; phase = 'preScript';
        }
        continue;
      }

      /* --- 身份注释 # @file_id / # @interface_id ---
       * 位置很关键：必须在 ### 分支与脚本块之后、普通注释之前判定，
       * 否则会被当成「纯注释」直接吞掉。 */
      var idm = ID_LINE_RE.exec(trimmed);
      if (idm) {
        var idKind = idm[1].toLowerCase();
        var idRest = String(idm[2] || '').trim();
        var idVal = idRest ? idRest.split(/\s+/)[0] : '';
        var idOk = ID_VALUE_RE.test(idVal);
        if (idKind === 'file') {
          if (sawDelimiter) {
            warnings.push('第 ' + lineNo + ' 行的 @file_id 位于第一个 ### 之后，已忽略：文件身份要写在第一个请求分隔线之前');
          } else if (!idOk) {
            warnings.push('第 ' + lineNo + ' 行的 @file_id 值不合法（需 4–32 位字母、数字、下划线或短横线），已忽略');
          } else if (fileId && fileId !== idVal) {
            warnings.push('第 ' + lineNo + ' 行重复声明 @file_id，以第 ' + fileIdLine + ' 行的 ' + fileId + ' 为准');
          } else if (!fileId) {
            fileId = idVal;
            fileIdLine = lineNo;
          }
        } else if (!idOk) {
          warnings.push('第 ' + lineNo + ' 行的 @interface_id 值不合法（需 4–32 位字母、数字、下划线或短横线），已忽略');
        } else if (cur) {
          if (cur.interfaceId && cur.interfaceId !== idVal) {
            warnings.push('请求「' + (cur.name || cur.id) + '」有多个 @interface_id，保留第一个 ' + cur.interfaceId);
          } else if (!cur.interfaceId) {
            cur.interfaceId = idVal;
            cur.interfaceIdLine = lineNo;
          }
        } else {
          pendingInterfaceId = idVal;
          pendingInterfaceIdLine = lineNo;
        }
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 文件级变量 @name = value --- */
      if (/^@[\w.\-]+\s*=/.test(trimmed) && (!cur || phase === 'idle')) {
        var vm = trimmed.match(/^@([\w.\-]+)\s*=\s*(.*)$/);
        if (vm) { variables[vm[1]] = vm[2]; fileVars[vm[1]] = vm[2]; }
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 元数据注释 # @name --- */
      if (/^#\s*@name\s+/i.test(trimmed)) {
        var nn = trimmed.replace(/^#\s*@name\s+/i, '').trim();
        if (cur) cur.name = nn; else pendingName = nn;
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 纯注释 --- */
      if (/^(#|\/\/)/.test(trimmed)) {
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 空行：headers → body --- */
      if (trimmed === '') {
        if (phase === 'headers') phase = 'body';
        if (cur) cur.rawLines.push(raw);
        continue;
      }

      /* --- 请求行 --- */
      var mm = trimmed.match(METHOD_RE);
      var wsLine = !!mm && /^(WEBSOCKET|WSS?)$/i.test(mm[1]);
      /* body 里遇到 WEBSOCKET 行 = 上一条没写 ### 就接了下一条。
       * 以前这里不认，整块被当成上一条的 body 静默吞掉（GET 莫名背上
       * "WEBSOCKET ws://...\nhello"，连 warning 都没有）。
       * 只为 WS 放宽：普通方法名出现在 body 里太常见（JSON 里有 "GET" 这种字符串），
       * 一概切开会把正常的 body 切碎。 */
      if (mm && (phase === 'idle' || (cur && phase === 'headers' && cur.url === '') || (cur && phase === 'body' && wsLine))) {
        if (cur) finish();
        var mmMethod = mm[1].toUpperCase();
        if (mmMethod === 'WS' || mmMethod === 'WSS') mmMethod = 'WEBSOCKET';
        startRequest({ method: mmMethod, url: mm[2] }, lineNo);
        if (pendingPreScript && pendingPreScript.length) {
          cur.preScript = pendingPreScript.join('\n');
          pendingPreScript = null;
        }
        cur.rawLines.push(raw);
        continue;
      }

      /* --- 请求外的杂项：忽略并提示 --- */
      if (!cur) {
        if (trimmed) warnings.push('第 ' + lineNo + ' 行在任何请求之外，已忽略：' + trimmed.slice(0, 60));
        continue;
      }

      cur.rawLines.push(raw);

      /* --- 外部文件引用 < ./body.json ---
       * 只有「body 还空着」时才算「整包 body 来自文件」；
       * multipart 分段里的 `< 附件路径` 必须原样留在 body 里，交给 parseMultipart 处理。 */
      if (/^<\s+/.test(trimmed) && !bodyBuf.length && !cur.bodyFromFile) {
        var bf = trimmed.replace(/^<\s+/, '').trim();
        if (/^<>/.test(bf)) {
          warnings.push('请求「' + (cur.name || cur.id) + '」使用 multipart(<>)，请改用 < 文件 或直接写 --boundary 形式的 body');
        } else {
          cur.bodyFromFile = bf;
        }
        continue;
      }

      /* --- 响应另存 > ./out.json（排除脚本） --- */
      if (/^>{1,2}\s+/.test(trimmed) && !/\{%/.test(trimmed)) {
        cur.outputFile = trimmed.replace(/^>{1,2}\s+/, '').trim();
        continue;
      }

      /* --- Header 行 --- */
      if (phase === 'headers' && /^[^:\s][^:]*:\s*/.test(line)) {
        var ci = line.indexOf(':');
        cur.headers.push({ k: line.slice(0, ci).trim(), v: line.slice(ci + 1).trim() });
        continue;
      }

      /* --- Body --- */
      if (phase === 'body' || phase === 'headers') {
        if (phase === 'headers') phase = 'body';
        bodyBuf.push(raw);
      }
    }

    finish();
    if (pendingPreScript && pendingPreScript.length) {
      warnings.push('文件末尾前的预请求脚本未关联到请求，已忽略');
    }

    /* 相对 URL 提示 */
    requests.forEach(function (r) {
      if (r.url && !/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//.test(r.url) && r.url.indexOf('{{') !== 0) {
        warnings.push('请求「' + r.name + '」的 URL 为相对地址，需配合 {{baseUrl}} 或完整 URL');
      }
    });

    return {
      fileName: sourceFile,
      fileId: fileId,
      fileIdLine: fileIdLine,
      variables: variables,
      fileVars: fileVars,
      requests: requests,
      warnings: warnings
    };
  }

  /* 简易 JSONPath：仅 $.a.b[0].c / a.b 形式，够用于 IDEA 的 response.body.$.token */
  function jsonPath(obj, path) {
    if (obj == null) return undefined;
    var p = String(path || '').trim().replace(/^\$\.?/, '');
    if (!p) return obj;
    var parts = p.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    var v = obj;
    for (var i = 0; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /* 变量求值。
   * ctx: { vars, envs, activeEnv, responses }
   *   vars       — 文件级 @变量（优先级最高）
   *   envs       — { dev: {k:v}, prod: {...} }，来自 http-client.env.json
   *   activeEnv  — 当前环境名
   *   responses  — { 请求名: { status, headers, text, parsed, ... } }，来自本次「运行全部」已完成的请求
   * 未命中的占位符原样保留（与 app.js resolveVars 行为一致）。 */
  function resolveVars(text, ctx) {
    if (text == null || String(text).indexOf('{{') < 0) return text;
    ctx = ctx || {};
    var vars = ctx.vars || {};
    var env = (ctx.envs && ctx.activeEnv && ctx.envs[ctx.activeEnv]) || {};
    var responses = ctx.responses || {};
    return String(text).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (m, key) {
      key = String(key).trim();

      /* 内置动态变量 */
      if (key === '$guid') return uuid();
      if (key === '$timestamp') return String(Date.now());
      if (key === '$datetimeIso') return new Date().toISOString();
      if (key === '$randomInt') return String(Math.floor(Math.random() * 1000000));

      /* 跨请求响应引用：name.response.body.$.path / name.response.headers.X
       * 名字允许中文和空格（\w 在 JS 里只认 ASCII，用 \p{L} 才认「登录」「甲 用文件变量」这种标题） */
      var rm = key.match(/^([\p{L}\p{N}_.\- ]+)\.response\.(body|headers)(?:\.\$?\.?(.*))?$/iu);
      if (rm) {
        var resp = responses[rm[1]];
        if (!resp) return m;
        if (rm[2].toLowerCase() === 'headers') {
          var hk = (rm[3] || '').toLowerCase();
          var hs = resp.headers || {};
          var found = Object.keys(hs).find(function (k) { return k.toLowerCase() === hk; });
          return found ? String(hs[found]) : m;
        }
        var body = resp.parsed !== undefined ? resp.parsed : (function () {
          try { return JSON.parse(resp.text || ''); } catch (e) { return undefined; }
        })();
        var val = jsonPath(body, rm[3] || '');
        return val === undefined ? m : (typeof val === 'object' ? JSON.stringify(val) : String(val));
      }

      if (Object.prototype.hasOwnProperty.call(vars, key)) return String(vars[key]);
      if (Object.prototype.hasOwnProperty.call(env, key)) return String(env[key]);
      return m;
    });
  }

  /* 变量值自己也可能含占位符（`@token = {{$guid}}`、`@url = {{base}}/v1`），
   * 只展开一层的话发出去就是字面 `{{$guid}}`。这里最多再叠 3 层，
   * 一旦某一轮没有变化就停 —— 互相引用的环不会死循环。 */
  function resolveDeep(text, ctx) {
    var out = resolveVars(text, ctx);
    for (var i = 0; i < 3; i++) {
      if (out == null || String(out).indexOf('{{') < 0 || out === text) break;
      text = out;
      out = resolveVars(out, ctx);
    }
    return out;
  }

  /* 把解析出的 request 转成 app.js 的 tab seed（headers 需要 id/on 字段，由调用方注入 uid）。
   * opts: { uid, resolveText, blankRow } */
  function toTab(req, opts) {
    opts = opts || {};
    var uid = opts.uid || function () { return 'r' + Math.random().toString(36).slice(2); };
    var rv = opts.resolveText || function (s) { return s; };
    var headers = (req.headers || []).map(function (h) {
      return { id: uid(), on: true, k: rv(h.k), v: rv(h.v) };
    });
    if (opts.blankRow) headers.push(opts.blankRow());
    var body = rv(req.body || '');
    var bodyType = req.bodyType === 'form' ? 'form' : (req.bodyType === 'json' ? 'json' : (body ? 'text' : 'none'));
    return {
      name: req.name,
      method: req.method,
      url: rv(req.url),
      headers: headers,
      params: opts.blankRow ? [opts.blankRow()] : [],
      formBody: opts.blankRow ? [opts.blankRow()] : [],
      bodyType: bodyType,
      body: body,
      httpSource: { file: req.sourceFile, id: req.id, name: req.name, line: req.line, interfaceId: req.interfaceId }
    };
  }

  /* 合并 http-client.env.json + http-client.private.env.json（private 覆盖同名 key）。 */
  function mergeEnvFiles(publicEnv, privateEnv) {
    var out = {};
    [publicEnv, privateEnv].forEach(function (doc) {
      if (!doc || typeof doc !== 'object') return;
      Object.keys(doc).forEach(function (envName) {
        var v = doc[envName];
        if (!v || typeof v !== 'object' || Array.isArray(v)) return;
        out[envName] = Object.assign({}, out[envName] || {}, v);
      });
    });
    return out;
  }

  /* ---- 序列化（解析的逆运算）----
   * 用途只有两处：新建文件、旧数据迁移。
   * 日常改字段必须走 HttpStore.writeRequest() 的段落级替换 —— 整文件重序列化会把
   * 用户手写的排版、注释、空行规范化掉（约束 2）。 */
  function serializeRequest(req, opts) {
    opts = opts || {};
    var eol = opts.eol || '\n';
    var notes = opts.notes !== false;
    var out = [];
    out.push(req.title ? '### ' + req.title : '###');
    if (req.interfaceId) {
      out.push('# @interface_id ' + req.interfaceId + (notes ? '  ' + ID_NOTE.interface : ''));
    }
    if (req.title && req.name && req.name !== req.title) out.push('# @name ' + req.name);
    if (req.preScript) String(req.preScript).split(/\r?\n/).forEach(function (l) { out.push(l); });
    out.push(String(req.method || 'GET').toUpperCase() + ' ' + String(req.url || ''));
    (req.headers || []).forEach(function (h) {
      if (!h || !h.k) return;
      out.push(h.k + ': ' + (h.v == null ? '' : h.v));
    });
    var body = req.body == null ? '' : String(req.body);
    if (req.bodyFromFile) {
      out.push('');
      out.push('< ' + req.bodyFromFile);
    } else if (body) {
      out.push('');
      body.split(/\r?\n/).forEach(function (l) { out.push(l); });
    }
    if (req.outputFile) out.push('> ' + req.outputFile);
    if (req.postScript) String(req.postScript).split(/\r?\n/).forEach(function (l) { out.push(l); });
    return out.join(eol);
  }

  /* doc: { fileId, fileVars, requests }；block 之间空一行，文件末尾留一个换行。 */
  function serializeCollection(doc, opts) {
    opts = opts || {};
    var eol = opts.eol || '\n';
    var parts = [];
    var head = [];
    if (opts.header) String(opts.header).split(/\r?\n/).forEach(function (l) { head.push(l); });
    if (doc.fileId) head.push('# @file_id ' + doc.fileId + (opts.notes === false ? '' : '  ' + ID_NOTE.file));
    var vars = doc.fileVars || {};
    Object.keys(vars).forEach(function (k) { head.push('@' + k + ' = ' + vars[k]); });
    if (head.length) parts.push(head.join(eol));
    (doc.requests || []).forEach(function (r) { parts.push(serializeRequest(r, opts)); });
    return parts.join(eol + eol) + eol;
  }

  var api = {
    METHODS: METHODS,
    parseHttpFile: parseHttpFile,
    parseMultipart: parseMultipart,
    mpToBody: mpToBody,
    mpFromBody: mpFromBody,
    guessBoundary: guessBoundary,
    mpBaseName: mpBaseName,
    mpMime: mpMime,
    serializeRequest: serializeRequest,
    serializeCollection: serializeCollection,
    ID_NOTE: ID_NOTE,
    resolveVars: resolveVars,
    resolveDeep: resolveDeep,
    toTab: toTab,
    mergeEnvFiles: mergeEnvFiles,
    jsonPath: jsonPath,
    safeName: safeName
  };
  root.POLARIS_HTTP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
