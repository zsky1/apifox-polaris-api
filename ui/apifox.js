/* apifox.js — 在 apifox 全部原生功能之上叠加 Apifox 拉取（只读）。
 *
 * 设计边界（不要越界）：
 *   1. Apifox 只是上游数据源：只从 Apifox 拉取接口与环境到本地，不回写 Apifox。
 *   2. 侧栏仍然只认 wpa-workspace.json —— 拉取的接口写成 Apifox-*.http 后按原流程挂载。
 *   3. 环境仍然只认 http-client.env.json —— 拉取的环境合并写回这个本地文件。
 *   4. 本地接口的增删改完全走原项目自己的流程，与 Apifox 无关。
 *   5. 网络全部走 sidecar 的 apifox/* 只读 RPC，UI 不直接 fetch（无 CORS / 无 token 暴露）。
 */
(function () {
  var C = window.POLARIS_CORE || {};
  var DBX = window.DBXBridge;
  var H = window.POLARIS_HTTP;
  var STORE = window.POLARIS_STORE;
  var CFG_KEY = 'apifox.sync.v1';

  var DEFAULT_CFG = {
    baseUrl: 'https://api.apifox.com',
    projectId: '',
    apiVersion: '2024-03-28',
    clientVersion: '2.8.28-alpha.1',
    accessToken: ''
  };

  var cfg = null;
  var ready = false;
  var busy = false;
  var suppress = 0;
  var lastTree = null;
  var lastEnvs = null;
  var noteFn = null;

  function status(msg, kind) { try { C.setStatus(msg, kind || ''); } catch (e) { } }
  function toast(msg) { try { C.toast(msg); } catch (e) { } }
  function errText(e) { return (e && e.message) || String(e || '未知错误'); }
  function setNote(msg, kind) { if (noteFn) { try { noteFn(msg, kind); } catch (e) { } } }
  function busyBtn(btn, text) {
    if (!btn) return;
    if (btn.dataset && btn.dataset.afOld == null) btn.dataset.afOld = btn.textContent;
    btn.disabled = true;
    btn.textContent = text;
  }
  function freeBtn(btn) {
    if (!btn || !btn.dataset || btn.dataset.afOld == null) return;
    btn.textContent = btn.dataset.afOld;
    btn.disabled = false;
    delete btn.dataset.afOld;
  }
  function str(v) { return v == null ? '' : String(v); }
  function upper(v) { return str(v).trim().toUpperCase(); }
  function firstText(o, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = o && o[keys[i]];
      if (v == null) continue;
      var s = str(v).trim();
      if (s) return s;
    }
    return '';
  }

  /* Apifox 内部 API 的 parameters / headers 可能是数组、分组对象或名称映射；
   * 无论哪种形态都先归一化成数组，避免 forEach is not a function。 */
  var PARAM_GROUPS = {
    header: 1, headers: 1, query: 1, path: 1, cookie: 1,
    body: 1, form: 1, formdata: 1
  };
  function asArray(v, group) {
    if (Array.isArray(v)) {
      if (!group) return v;
      return v.map(function (x) {
        if (!x || typeof x !== 'object' || x.in || x.location || x.position || x._group) return x;
        var y = Object.assign({}, x);
        y._group = group;
        return y;
      });
    }
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return [];
      if (s.charAt(0) === '[' || s.charAt(0) === '{') {
        try { return asArray(JSON.parse(s), group); } catch (e) { }
      }
      return [];
    }
    if (!v || typeof v !== 'object') return [];
    if (v.items != null) return asArray(v.items, group);
    if (v.list != null) return asArray(v.list, group);
    if (v.values != null) return asArray(v.values, group);
    if (v.name != null || v.key != null || v.in != null || v.headerName != null) return [v];

    var keys = Object.keys(v);
    var out = [];
    var grouped = false;
    var i;
    for (i = 0; i < keys.length; i++) {
      var gk = keys[i].toLowerCase();
      if (PARAM_GROUPS[gk] && v[keys[i]] && typeof v[keys[i]] === 'object') {
        grouped = true;
        out = out.concat(asArray(v[keys[i]], gk));
      }
    }
    if (grouped) return out;
    for (i = 0; i < keys.length; i++) {
      var name = keys[i];
      var value = v[name];
      if (value && typeof value === 'object') {
        var item = Object.assign({}, value);
        if (!item.name && !item.key && !item.headerName) item.name = name;
        out.push(item);
      } else {
        out.push({ name: name, value: value });
      }
    }
    return out;
  }
  function headerLine(s) {
    var m = /^\s*([^:]+?)\s*:\s*([\s\S]*)$/.exec(str(s));
    return m ? { name: m[1], value: m[2] } : { name: str(s).trim(), value: '' };
  }
  function paramPlace(p) {
    return str(p && (p.in || p.location || p.position || p.paramIn || p._group)).toLowerCase();
  }

  function publicCfg() {
    return Object.assign({}, DEFAULT_CFG, cfg || {});
  }

  async function loadCfg() {
    if (!DBX) return Object.assign({}, DEFAULT_CFG);
    var v = await DBX.storage.get(CFG_KEY).catch(function () { return null; });
    cfg = Object.assign({}, DEFAULT_CFG, v && typeof v === 'object' ? v : {});
    return publicCfg();
  }

  async function saveCfg(next) {
    cfg = Object.assign({}, DEFAULT_CFG, next || {});
    if (DBX) await DBX.storage.set(CFG_KEY, cfg).catch(function () { });
    return publicCfg();
  }

  function invoke(method, extra) {
    if (!DBX || !DBX.invoke) return Promise.reject(new Error('DBX 桥不可用'));
    var params = Object.assign({}, extra || {}, { config: publicCfg() });
    return DBX.invoke(method, params);
  }

  function docs() { return window.POLARIS_DOCS || null; }

  function metaObj() {
    var d = docs();
    var m = d && d.map ? d.map() : null;
    var x = m && m.apifox && typeof m.apifox === 'object' ? m.apifox : {};
    x.version = 1;
    x.folderMap = x.folderMap || {};
    x.interfaceMap = x.interfaceMap || {};
    x.envMap = x.envMap || {};
    x.fileSnapshots = x.fileSnapshots || {};
    x.pulledFiles = x.pulledFiles || [];
    return x;
  }

  async function saveMeta(x) {
    var d = docs();
    if (!d || !d.map || !d.saveMap) return false;
    var m = d.map();
    if (!m) return false;
    m.apifox = x;
    try { return await d.saveMap(); } catch (e) { return false; }
  }

  function newIid() {
    var s = '';
    try {
      var a = new Uint8Array(6);
      (window.crypto || window.msCrypto).getRandomValues(a);
      for (var i = 0; i < a.length; i++) s += a[i].toString(36).padStart(2, '0');
    } catch (e) {
      s = Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
    return s.replace(/[^a-z0-9]/gi, '').slice(0, 8).padEnd(8, 'x');
  }

  function safeName(s) {
    return str(s).replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '未分类';
  }

  function pathOf(url) {
    var u = str(url).trim();
    if (!u) return '/';
    if (u.indexOf('{{baseUrl}}') === 0) return u.slice('{{baseUrl}}'.length) || '/';
    if (/^https?:\/\//i.test(u)) {
      try { var x = new URL(u); return (x.pathname || '/') + (x.search || ''); } catch (e) { }
    }
    return u;
  }

  /* 从接口定义里尽量还原 headers / body；拿不到就只同步方法、路径、名称。 */
  function defHeaders(def) {
    var out = [];
    if (!def || typeof def !== 'object') return out;
    asArray(def.headers || def.header || []).forEach(function (h) {
      var o = typeof h === 'string' ? headerLine(h) : h;
      if (!o || typeof o !== 'object') return;
      var k = firstText(o, ['name', 'key', 'headerName']);
      if (!k) return;
      var v = firstText(o, ['value', 'example', 'default']);
      if (/^(content-type|authorization|accept)$/i.test(k) || v) out.push(k + ': ' + v);
    });
    asArray(def.parameters || def.params || []).forEach(function (p) {
      var o = typeof p === 'string' ? headerLine(p) : p;
      if (!o || typeof o !== 'object') return;
      var place = paramPlace(o);
      var k = firstText(o, ['name', 'key', 'headerName']);
      if (!k) return;
      if (place) {
        if (place !== 'header' && place !== 'headers') return;
      } else if (!/^(x-|content-type$|authorization$|accept$)/i.test(k)) {
        return;
      }
      var v = firstText(o, ['value', 'example', 'default']);
      out.push(k + ': ' + v);
    });
    return out;
  }

  function defBody(def) {
    if (!def || typeof def !== 'object') return '';
    var rb = def.requestBody || def.body || def.apiRequestBody;
    if (typeof rb === 'string') return rb;
    if (rb && typeof rb === 'object') {
      if (typeof rb.body === 'string' && rb.body) return rb.body;
      if (rb.content && typeof rb.content === 'object') {
        var keys = Object.keys(rb.content);
        for (var i = 0; i < keys.length; i++) {
          var c = rb.content[keys[i]] || {};
          var ex = c.example != null ? c.example : (c.schema && c.schema.example);
          if (ex != null) return typeof ex === 'string' ? ex : JSON.stringify(ex, null, 2);
        }
      }
      if (rb.example != null) return typeof rb.example === 'string' ? rb.example : JSON.stringify(rb.example, null, 2);
    }
    return '';
  }

  function serializeApifoxFile(entries) {
    var blocks = [];
    entries.forEach(function (e) {
      var n = e.node || {};
      var lines = [];
      lines.push('### ' + (firstText(n, ['name']) || firstText(n, ['path']) || '未命名接口'));
      lines.push('# @interface_id ' + e.iid);
      var url = '{{baseUrl}}' + str(n.path || '/');
      if (/^https?:\/\//i.test(str(n.path))) url = str(n.path);
      lines.push(upper(n.method || 'GET') + ' ' + url);
      defHeaders(n.definition).forEach(function (h) { lines.push(h); });
      var body = defBody(n.definition);
      if (body) { lines.push(''); lines.push(body); }
      blocks.push(lines.join('\n'));
    });
    return blocks.join('\n\n') + '\n';
  }

  function walkTree(nodes, folderPath, out) {
    asArray(nodes).forEach(function (n) {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'folder') {
        var p = folderPath ? folderPath + '/' + str(n.name || '') : str(n.name || '');
        walkTree(asArray(n.children), p.replace(/^\/+|\/+$/g, ''), out);
      } else if (n.type === 'api') {
        out.push({ node: n, folderPath: folderPath || '' });
      }
    });
    return out;
  }

  /* ---------- Apifox → 本地 ---------- */

  async function pull(forceCfg) {
    if (busy) { status('Apifox 同步正在进行中…', 'warn'); setNote('Apifox 同步正在进行中…', 'warn'); return false; }
    busy = true;
    setNote('正在从 Apifox 拉取接口树…');
    var suppressed = false;
    try {
      if (forceCfg) await saveCfg(forceCfg);
      if (!cfg || !cfg.projectId || !cfg.accessToken) {
        openSettings();
        status('请先填写 Apifox 项目 ID 与 Access Token', 'warn');
        setNote('请先填写 Apifox 项目 ID 与 Access Token', 'err');
        return false;
      }
      var d = docs();
      if (!d || !d.enabled || !d.enabled() || !d.dir || !d.dir()) {
        status('工作区尚未就绪，请稍后再同步', 'warn');
        setNote('工作区尚未就绪，请稍后再同步', 'err');
        return false;
      }
      status('正在从 Apifox 拉取接口树…');
      var tree = await invoke('apifox/getApiTree', {});
      var nodes = tree && Array.isArray(tree.nodes) ? tree.nodes : [];
      lastTree = tree;
      var apis = walkTree(nodes, '', []);
      var byFolder = {};
      apis.forEach(function (a) {
        var key = a.folderPath || '未分类';
        (byFolder[key] = byFolder[key] || []).push(a);
      });

      var meta = metaObj();
      var nextMeta = {
        version: 1,
        projectId: cfg.projectId,
        source: tree.source || '',
        lastPullAt: Date.now(),
        folderMap: {},
        interfaceMap: {},
        envMap: meta.envMap || {},
        fileSnapshots: {},
        pulledFiles: []
      };

      suppress++; suppressed = true;
      var dir = d.dir();
      for (var folder of Object.keys(byFolder)) {
        var fileName = 'Apifox-' + safeName(folder) + '.http';
        var path = STORE.joinPath(dir, fileName);
        var entries = byFolder[folder].map(function (a) {
          var n = a.node;
          var iid = newIid();
          var apiId = firstText(n, ['id', 'apiId']) || str(n.id);
          nextMeta.interfaceMap[iid] = {
            apiId: apiId,
            name: firstText(n, ['name']) || str(n.path),
            method: upper(n.method || 'GET'),
            path: str(n.path || '/'),
            folderPath: folder,
            folderId: firstText(n.definition || {}, ['folderId', 'apiFolderId', 'apiDetailFolderId']),
            degraded: !!n.degraded,
            definition: n.definition || {},
            file: path
          };
          return { iid: iid, node: n };
        });
        await DBX.invoke('http/writeFile', { path: path, content: serializeApifoxFile(entries) });
        await d.register(path);
        nextMeta.folderMap[folder] = { file: path, fileName: fileName };
        nextMeta.pulledFiles.push(path);
        nextMeta.fileSnapshots[path] = entries.map(function (e) {
          var n = e.node;
          return { iid: e.iid, name: firstText(n, ['name']) || str(n.path), method: upper(n.method), path: str(n.path) };
        });
      }

      status('接口树已落地，正在同步环境…');
      setNote('接口树已落地（' + apis.length + ' 个接口），正在同步环境…');
      var envResult = await invoke('apifox/listEnvironments', {});
      var envItems = envResult && Array.isArray(envResult.items) ? envResult.items : [];
      lastEnvs = envItems;
      var current = {};
      try {
        var raw = await DBX.invoke('http/readEnvFiles', { dir: dir });
        current = raw && raw.public && typeof raw.public === 'object' ? raw.public : {};
      } catch (e) { current = {}; }
      var localEnvs = {};
      var newEnvMap = {};
      envItems.forEach(function (item) {
        var name = firstText(item, ['name']);
        if (!name) return;
        var o = {};
        var rows = Array.isArray(item.baseUrlRows) ? item.baseUrlRows : [];
        var baseUrl = '';
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].url) { baseUrl = str(rows[i].url); if (rows[i].id === 'default') break; }
        }
        if (!baseUrl && item.baseUrls && typeof item.baseUrls === 'object') {
          var bks = Object.keys(item.baseUrls);
          if (bks.length) baseUrl = str(item.baseUrls[bks[0]]);
        }
        if (baseUrl) o.baseUrl = baseUrl;
        var vars = Array.isArray(item.variables) ? item.variables : [];
        vars.forEach(function (v) {
          var k = firstText(v, ['name', 'key']);
          if (!k || k === 'baseUrl') return;
          o[k] = str(v.value != null ? v.value : (v.default != null ? v.default : ''));
        });
        localEnvs[name] = o;
        newEnvMap[name] = { envId: firstText(item, ['id']), name: name };
      });
      Object.keys(current).forEach(function (name) {
        if (!newEnvMap[name]) localEnvs[name] = current[name];
      });
      await DBX.invoke('http/writeFile', {
        path: STORE.joinPath(dir, 'http-client.env.json'),
        content: JSON.stringify(localEnvs, null, 2) + '\n'
      });
      nextMeta.envMap = newEnvMap;
      await saveMeta(nextMeta);
      await d.refresh(true);
      if (window.POLARIS_API && window.POLARIS_API.reloadEnvs) await window.POLARIS_API.reloadEnvs();
      var done = '已同步 ' + apis.length + ' 个 Apifox 接口（' + (tree.source || '未知来源') + '）和 ' + envItems.length + ' 个环境';
      if (tree && tree.note) done += '；' + tree.note;
      status(done, 'ok');
      setNote(done, 'ok');
      toast('Apifox 同步完成 <b>✓</b>');
      return true;
    } catch (e) {
      var fail = 'Apifox 同步失败：' + errText(e);
      status(fail, 'err');
      setNote(fail, 'err');
      toast(fail);
      return false;
    } finally {
      if (suppressed) suppress--;
      busy = false;
    }
  }

  /* ---------- 配置弹窗 ---------- */

  function formCfg() {
    var q = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
    return {
      baseUrl: q('afBase') || DEFAULT_CFG.baseUrl,
      projectId: q('afProject'),
      apiVersion: q('afApiVer') || DEFAULT_CFG.apiVersion,
      clientVersion: q('afClientVer') || DEFAULT_CFG.clientVersion,
      accessToken: q('afToken')
    };
  }

  function openSettings() {
    var bg = document.getElementById('modalBg');
    if (!bg) return;
    var c = publicCfg();
    var m = document.createElement('div');
    m.className = 'modal wide';
    m.innerHTML =
      '<h3>Apifox 拉取</h3>' +
      '<div class="sub">保留本插件原有的 .http 编辑、历史、SSE/WebSocket 等全部功能。这里只设置 Apifox 上游，接口拉取后写入 Apifox-*.http，环境写入 http-client.env.json。本插件为只读：本地增删改不会回写到 Apifox。</div>' +
      '<div class="field"><label>API Base URL</label><input id="afBase" spellcheck="false" value="' + C.esc(c.baseUrl) + '" /></div>' +
      '<div class="field"><label>项目 ID（Project ID）</label><input id="afProject" spellcheck="false" placeholder="数字项目 ID" value="' + C.esc(c.projectId) + '" /></div>' +
      '<div class="field"><label>Access Token</label><input id="afToken" type="password" spellcheck="false" placeholder="只保存在本机插件配置，不写入 .http" value="' + C.esc(c.accessToken) + '" /></div>' +
      '<div class="field"><label>API 版本头 X-Apifox-Api-Version</label><input id="afApiVer" spellcheck="false" value="' + C.esc(c.apiVersion) + '" /></div>' +
      '<div class="field"><label>客户端版本头 X-Client-Version</label><input id="afClientVer" spellcheck="false" value="' + C.esc(c.clientVersion) + '" /></div>' +
      '<div id="afNote" style="min-height:20px;margin:10px 0 2px;font-size:12px;color:#9aa7b8"></div>' +
      '<div class="acts" style="gap:8px;flex-wrap:wrap">' +
      '<button class="btn" id="afTest">测试连接</button>' +
      '<button class="btn primary" id="afPull">从 Apifox 拉取</button>' +
      '<button class="btn" id="afDiag">诊断数量</button>' +
      '<span style="flex:1"></span>' +
      '<button class="btn ghost" id="afSave">保存配置</button>' +
      '<button class="btn ghost" id="afClose">关闭</button>' +
      '</div>';
    bg.innerHTML = '';
    bg.appendChild(m);
    bg.classList.add('open');
    var noteBox = m.querySelector('#afNote');
    var note = function (msg, kind) {
      if (!noteBox) return;
      noteBox.textContent = msg || '';
      noteBox.style.color = kind === 'err' ? '#ff7b7b' : (kind === 'ok' ? '#5ddb9a' : (kind === 'warn' ? '#ffc857' : '#9aa7b8'));
    };
    noteFn = note;
    note('就绪。可先「测试连接」，确认通过后再拉取。');
    var close = function () { noteFn = null; bg.classList.remove('open'); bg.innerHTML = ''; };
    m.querySelector('#afClose').onclick = close;
    bg.onclick = function (e) { if (e.target === bg) close(); };
    m.querySelector('#afSave').onclick = async function () {
      try {
        await saveCfg(formCfg());
        status('Apifox 配置已保存', 'ok');
        note('配置已保存', 'ok');
        setTimeout(close, 500);
      } catch (e) { note('配置保存失败：' + errText(e), 'err'); }
    };
    m.querySelector('#afTest').onclick = async function () {
      var btn = this;
      busyBtn(btn, '验证中…');
      note('正在验证 Apifox 连接…');
      try {
        await saveCfg(formCfg());
        status('正在验证 Apifox 连接…');
        var r = await invoke('apifox/test', {});
        var ok = !!(r && r.success);
        var msg = (ok ? '连接成功：' : '连接失败：') + ((r && r.message) || '');
        status(msg, ok ? 'ok' : 'err');
        note(msg, ok ? 'ok' : 'err');
      } catch (e) {
        var fail = '连接失败：' + errText(e);
        status(fail, 'err');
        note(fail, 'err');
      } finally { freeBtn(btn); }
    };
    m.querySelector('#afPull').onclick = async function () {
      var btn = this;
      busyBtn(btn, '拉取中…');
      note('正在从 Apifox 拉取接口树与环境…');
      try {
        await saveCfg(formCfg());
        var ok = await pull();
        if (ok) setTimeout(close, 900);
      } catch (e) {
        note('拉取失败：' + errText(e), 'err');
      } finally { freeBtn(btn); }
    };
    m.querySelector('#afDiag').onclick = async function () {
      var btn = this;
      busyBtn(btn, '诊断中…');
      note('正在诊断 Apifox 接口数量…');
      try {
        await saveCfg(formCfg());
        var r = await invoke('apifox/diagnoseSync', {});
        var d = r || {};
        var t = d.internalTree || {}, l = d.internalList || {}, o = d.openapi || {};
        var msg = '接口树 ' + (t.count || 0) + ' / 内部列表 ' + (l.count || 0) + ' / OpenAPI ' + (o.count || 0) + '；' + (d.conclusion || '');
        status('Apifox 数量诊断完成', 'ok');
        note(msg, 'ok');
      } catch (e) {
        var fail = '诊断失败：' + errText(e);
        status(fail, 'err');
        note(fail, 'err');
      } finally { freeBtn(btn); }
    };
  }

  function bind() {
    var b = document.getElementById('apifoxBtn');
    if (b) b.onclick = openSettings;
    var em = document.getElementById('envMenu');
    if (em) {
      /* 环境菜单每次重绘都会清空，用事件委托补一个入口，不改 app.js 的 renderEnv。 */
      em.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('[data-apifox-env]');
        if (!t) return;
        em.classList.remove('open');
        pull();
      });
      setInterval(function () {
        if (!em.querySelector('[data-apifox-env]')) {
          var x = document.createElement('button');
          x.className = 'env-item manage';
          x.setAttribute('data-apifox-env', '1');
          x.innerHTML = '<span>⇅ 从 Apifox 拉取接口与环境</span>';
          em.appendChild(x);
        }
      }, 800);
    }
  }

  window.POLARIS_APIFOX = {
    openSettings: openSettings,
    pull: pull,
    test: async function () { return invoke('apifox/test', {}); },
    invoke: invoke,
    newIid: newIid,
    config: publicCfg,
    lastTree: function () { return lastTree; },
    lastEnvs: function () { return lastEnvs; },
    /* 只读插件：不暴露任何回写钩子。保留 _test 供拉取归一化自测。 */
    _test: {
      asArray: asArray, defHeaders: defHeaders, walkTree: walkTree
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = window.POLARIS_APIFOX;

  (async function init() {
    if (DBX && DBX.ready) await DBX.ready;
    await loadCfg();
    bind();
    ready = true;
  })();
})();
