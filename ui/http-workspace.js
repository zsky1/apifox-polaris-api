/* http-workspace.js — 历史结果面板 + 结果落盘。
 *
 * S8.3：文件入口与「载入为 tab / 运行全部」已全部收口——打开 .http 只走顶栏「▤ 打开 .http」
 * （直连系统文件对话框）或侧栏映射树；批量运行在浮层顶栏的「▶▶ 全部运行」。
 * 这个面板只剩一件事：把每次「发送」自动落盘的结果列出来（`_results/`）。
 *
 * 依赖：window.POLARIS_HTTP（http-file.js）、window.DBXBridge、window.POLARIS_CORE、
 *        window.POLARIS_API（app.js 导出的最小接口）。
 * 设计原则：不改动 app.js 的 780 行主逻辑，只通过 POLARIS_API 与其交互；
 *           所有 sidecar 调用经 invokeSafe 降级，浏览器 dev 模式仍可解析 / 载入请求。
 *
 * sidecar 方法：http/defaultDirs listFiles readFile readEnvFiles
 *               saveResult listResults getResult deleteResult revealDir
 */
(function () {
  var H = window.POLARIS_HTTP;
  var CORE = window.POLARIS_CORE;
  var DBX = window.DBXBridge;
  var esc = function (s) { return CORE && CORE.esc ? CORE.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var ST_KEY = 'apifox.httpws.v1';
  /* 面板里有两层视图（S8.4）：
   *   list   —— 历史结果目录
   *   detail —— 某一条的快照（只读）
   * 两层在**同一个弹窗内**切换，不叠第二层浮层：叠起来用户还得管「关哪一层」。
   * 点「打开」不再直接跳到主界面 —— 那正是歧义的来源（到底是在看历史，
   * 还是把主界面当成了这条历史的详情页？）。 */
  var WS = {
    workDir: '',          // 仍要留着：_cancel/ 与 _history/ 都挂在这个根下
    resultsDir: '',
    results: [],
    runtimeResponses: {}, // 请求名 -> 最近一次 resp，供跨请求引用
    view: { mode: 'list', path: '' },
    listScroll: 0,        // 目录滚到哪儿了：返回时必须回到原处
    ready: false
  };

  /* ---------- 宿主调用（浏览器 dev 模式降级） ---------- */
  function hostAvailable() { return !!(DBX && DBX.readyOk !== false && DBX.plugin); }
  async function invokeSafe(method, params) {
    if (!hostAvailable()) throw new Error('浏览器开发模式：未连接 DBX 宿主，sidecar 方法不可用');
    return DBX.invoke(method, params || {});
  }
  async function storeGet(key) { try { return await DBX.storage.get(key); } catch (e) { return null; } }
  async function storeSet(key, val) { try { return await DBX.storage.set(key, val); } catch (e) { /* ignore */ } }
  /* app.js 导出的最小接口。原先是裸写 `api()`，没这个函数 —— 点「打开」就 ReferenceError，
   * 被 catch 吞成一句状态提示。这里补上，并容忍 app.js 还没加载完。 */
  function api() { return window.POLARIS_API || null; }

  /* ---------- 小工具 ---------- */
  function fmtTime(ms) {
    if (!ms) return '-';
    try { return new Date(Number(ms)).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return String(ms); }
  }
  function kB(n) { n = Number(n) || 0; return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function msText(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(2) + ' s' : n + ' ms'; }
  function b64ToBlob(b64, ct) {
    try {
      var bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: ct || 'application/octet-stream' });
    } catch (e) { return null; }
  }
  function statusClass(s) { return s >= 500 ? 's5' : s >= 400 ? 's4' : s >= 300 ? 's3' : 's2'; }

  /* response -> 可落盘的普通对象（去掉 blobUrl，parsed 可由 text 重建） */
  function serializableResponse(resp) {
    return {
      status: resp.status, statusText: resp.statusText, ok: resp.ok,
      contentType: resp.contentType, headers: resp.headers || {},
      text: resp.text || '', isBase64: !!resp.isBinary,
      size: resp.size || 0, timeMs: resp.timeMs || 0, url: resp.url
    };
  }
  /* 落盘结果 -> app.js response（历史结果重新打开） */
  function respFromSaved(r) {
    var ct = r.contentType || '';
    var isBin = !!r.isBase64 || (CORE.BINARY.test(ct));
    var text = r.text || '';
    var blobUrl = null;
    if (isBin && text) {
      var blob = b64ToBlob(text, ct);
      if (blob) blobUrl = URL.createObjectURL(blob);
    }
    var parsed = isBin ? { ok: false } : CORE.tryJSON(text);
    return {
      status: r.status, statusText: r.statusText || '', ok: !!r.ok,
      timeMs: r.timeMs || 0, size: r.size || 0, contentType: ct,
      headers: r.headers || {}, text: text, isBinary: isBin, blobUrl: blobUrl,
      url: r.url || '', parsed: parsed.ok ? parsed.value : undefined
    };
  }

  /* ---------- 样式（不侵入 app.css） ---------- */
  function injectCss() {
    var css = [
      '.pa-hws{position:fixed;inset:0;z-index:9000;font-size:13px;color:var(--fg,#e6e7eb)}',
      '.pa-hws[hidden]{display:none}',
      '.pa-hws-mask{position:absolute;inset:0;background:rgba(0,0,0,.5)}',
      '.pa-hws-box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,94vw);height:auto;max-height:min(660px,88vh);display:flex;flex-direction:column;background:var(--bg-2,#1e1f26);border:1px solid var(--line,#2a2b32);border-radius:12px;box-shadow:0 16px 48px rgba(0,0,0,.45);overflow:hidden}',
      '[data-dbx-theme="light"] .pa-hws-box{background:#fff;color:#222;border-color:#d8d9de;box-shadow:0 16px 48px rgba(0,0,0,.18)}',
      '.pa-hws-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line,#2a2b32);flex:none}',
      '[data-dbx-theme="light"] .pa-hws-head{border-color:#e4e5ea}',
      '.pa-hws-title{font-weight:500;font-size:14px;white-space:nowrap}',
      '.pa-hws-tabs{display:flex;gap:4px;margin-left:8px}',
      '.pa-hws-tabs button,.pa-hws button{font:inherit;cursor:pointer;border-radius:6px;border:1px solid var(--line,#35363e);background:transparent;color:inherit;padding:5px 11px}',
      '.pa-hws-tabs button.on{background:var(--brand,#4c8bf5);border-color:transparent;color:#fff}',
      '.pa-hws button:hover{border-color:var(--brand,#4c8bf5)}',
      '.pa-hws button.primary{background:var(--brand,#4c8bf5);border-color:transparent;color:#fff}',
      '.pa-hws button:disabled{opacity:.45;cursor:default}',
      '.pa-hws-close{margin-left:auto;font-size:17px;line-height:1;padding:2px 9px!important}',
      '.pa-hws-body{flex:1 1 auto;min-height:200px;overflow:auto;padding:14px 16px}',
      '.pa-hws-pane[hidden]{display:none}',
      '.pa-hws-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.pa-hws input[type=text],.pa-hws select{font:inherit;padding:6px 9px;border-radius:6px;border:1px solid var(--line,#35363e);background:var(--bg-1,#17181d);color:inherit;min-width:0}',
      '[data-dbx-theme="light"] .pa-hws input[type=text],[data-dbx-theme="light"] .pa-hws select{background:#fafbfc;border-color:#d8d9de;color:#222}',
      '.pa-hws .grow{flex:1;min-width:180px}',
      '.pa-hws label.lbl{color:var(--dim,#9a9ba3);white-space:nowrap;font-size:12px}',
      '.pa-hws h4{margin:14px 0 8px;font-size:13px;font-weight:500;color:var(--dim,#9a9ba3)}',
      '.pa-hws-list{border:1px solid var(--line,#2a2b32);border-radius:8px;overflow:auto;max-height:330px}',
      '[data-dbx-theme="light"] .pa-hws-list{border-color:#e4e5ea}',
      '.pa-hws-item{display:flex;align-items:center;gap:9px;padding:8px 10px;border-bottom:1px solid var(--line,#2a2b32)}',
      '.pa-hws-item:last-child{border-bottom:0}',
      '[data-dbx-theme="light"] .pa-hws-item{border-color:#eef0f3}',
      '.pa-hws-item:hover{background:rgba(127,127,127,.08)}',
      '.pa-hws-item .name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}',
      /* 时间/耗时/大小这一列不参与压缩：名字长就把名字省略，别把「几点发的」切掉半截 */
      '.pa-hws-item .url{color:var(--dim,#9a9ba3);white-space:nowrap;flex:0 0 auto;font-size:12px}',
      '.pa-hws-item .m,.pa-hws-dtop .m{font-size:11px;padding:1px 6px;border-radius:4px;background:rgba(76,139,245,.16);color:var(--brand,#4c8bf5);flex:none}',
      '.pa-hws-item .st,.pa-hws-dtop .st{font-size:11px;padding:1px 7px;border-radius:4px;flex:none}',
      '.pa-hws-item .st.s2,.pa-hws-dtop .st.s2{background:rgba(61,181,112,.16);color:#3db570}',
      '.pa-hws-item .st.s3,.pa-hws-dtop .st.s3{background:rgba(230,170,60,.16);color:#e0aa3c}',
      '.pa-hws-item .st.s4,.pa-hws-item .st.s5,.pa-hws-dtop .st.s4,.pa-hws-dtop .st.s5{background:rgba(230,90,90,.16);color:#e05a5a}',
      /* S8.4：返回列表后，刚才看的那条留在原位并高亮 —— 否则满屏长得一样的行，人找不到自己刚看的是哪条 */
      /* 行内按钮不参与收缩：名字把行挤满时，按钮不能断成「打/开」两行 */
      '.pa-hws-item button{flex:0 0 auto;white-space:nowrap}',
      '.pa-hws-item.on{background:rgba(76,139,245,.14);box-shadow:inset 2px 0 0 var(--brand,#4c8bf5)}',
      '.pa-hws-empty{padding:26px;text-align:center;color:var(--dim,#9a9ba3);line-height:1.8}',
      '.pa-hws-warn{margin-top:8px;padding:8px 10px;border-radius:6px;background:rgba(230,170,60,.10);color:#d39a2c;font-size:12px;line-height:1.7;max-height:110px;overflow:auto}',
      '.pa-hws-foot{flex:none;padding:8px 16px;border-top:1px solid var(--line,#2a2b32);font-size:12px;color:var(--dim,#9a9ba3);display:flex;gap:10px;align-items:center}',
      '[data-dbx-theme="light"] .pa-hws-foot{border-color:#e4e5ea}',
      '.pa-hws-foot .msg{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-hws-foot .msg.ok{color:#3db570}',
      '.pa-hws-foot .msg.err{color:#e05a5a}',

      /* ---- S8.4：面板内的第二层（单条快照） ---- */
      '.pa-hws-back{margin-right:2px;padding:3px 9px!important;line-height:1.15;font-size:14px}',
      '.pa-hws-back[hidden]{display:none}',
      '.pa-hws-badge{font-size:11px;padding:2px 7px;border-radius:4px;background:rgba(230,170,60,.16);color:#d39a2c;white-space:nowrap}',
      '.pa-hws-badge[hidden]{display:none}',
      '.pa-hws-dtop{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
      '.pa-hws-dtop .dname{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pa-hws-dmeta{font-size:12px;color:var(--dim,#9a9ba3);line-height:1.7;margin-bottom:10px;word-break:break-all}',
      '.pa-hws-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;padding:8px 10px;border-radius:6px;background:var(--bg-1,#17181d);border:1px solid var(--line,#2a2b32);word-break:break-all;margin-bottom:8px}',
      '[data-dbx-theme="light"] .pa-hws-url{background:#fafbfc;border-color:#e4e5ea}',
      '.pa-hws-fold{border:1px solid var(--line,#2a2b32);border-radius:8px;margin-bottom:8px;overflow:hidden}',
      '[data-dbx-theme="light"] .pa-hws-fold{border-color:#e4e5ea}',
      '.pa-hws-fold>summary{cursor:pointer;padding:7px 10px;font-size:12px;color:var(--dim,#9a9ba3);list-style:none}',
      '.pa-hws-fold>summary::-webkit-details-marker{display:none}',
      '.pa-hws-fold>summary:before{content:"▸ "}',
      '.pa-hws-fold[open]>summary:before{content:"▾ "}',
      '.pa-hws-kv{width:100%;border-collapse:collapse;font-size:12px}',
      '.pa-hws-kv td{padding:5px 10px;border-top:1px solid var(--line,#2a2b32);vertical-align:top;word-break:break-all}',
      '[data-dbx-theme="light"] .pa-hws-kv td{border-color:#eef0f3}',
      '.pa-hws-kv td:first-child{color:var(--j-key,#7aa2f7);white-space:nowrap;width:1%}',
      '.pa-hws-seg{display:flex;gap:4px;margin:0 0 8px}',
      '.pa-hws-seg button.on{background:var(--brand,#4c8bf5);border-color:transparent;color:#fff}',
      '.pa-hws-dt .rpane[hidden]{display:none}',
      '.pa-hws-dt pre.raw{margin:0;padding:10px 12px;font-size:12.5px;line-height:1.6;white-space:pre;overflow:auto;max-height:min(300px,40vh);tab-size:2;background:var(--bg-1,#17181d);border:1px solid var(--line,#2a2b32);border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '[data-dbx-theme="light"] .pa-hws-dt pre.raw{background:#fafbfc;border-color:#e4e5ea}',
      '.pa-hws-fold pre.raw{border:0;border-top:1px solid var(--line,#2a2b32);border-radius:0;max-height:200px}',
      '[data-dbx-theme="light"] .pa-hws-fold pre.raw{border-color:#e4e5ea}',
      '.pa-hws-dt .tok-key{color:var(--j-key,#7aa2f7)}',
      '.pa-hws-dt .tok-str{color:var(--j-str,#ce9178)}',
      '.pa-hws-dt .tok-num{color:var(--j-num,#b5cea8)}',
      '.pa-hws-dt .tok-bool{color:var(--j-bool,#569cd6)}',
      '.pa-hws-dt .tok-null{color:var(--j-null,#808080)}',
      '.pa-hws-note{font-size:12px;color:#d39a2c;line-height:1.6;margin-bottom:6px}',
      '.pa-hws-img{max-width:100%;max-height:min(300px,40vh);border-radius:8px;border:1px solid var(--line,#2a2b32)}',
      '.pa-hws-acts{display:flex;gap:8px;align-items:center;margin-top:12px}',
      '.pa-hws-acts .hint{font-size:11.5px;color:var(--dim,#9a9ba3)}'
    ].join('\n');
    var st = document.createElement('style');
    st.setAttribute('data-pa-hws', '1');
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 面板骨架 ---------- */
  function buildPanel() {
    var root = document.getElementById('root') || document.body;
    var wrap = document.createElement('div');
    wrap.className = 'pa-hws';
    wrap.id = 'paHttpPanel';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="pa-hws-mask"></div>' +
      '<div class="pa-hws-box">' +
      '  <div class="pa-hws-head">' +
      '    <button class="pa-hws-back" title="返回历史结果列表" hidden>←</button>' +
      '    <span class="pa-hws-title">历史结果</span>' +
      '    <span class="pa-hws-badge" hidden>快照 · 只读</span>' +
      '    <button class="pa-hws-close" title="关闭">×</button>' +
      '  </div>' +
      '  <div class="pa-hws-body">' +
      '    <div class="pa-hws-pane" id="paHwsList">' +
      '      <div class="pa-hws-row"><button id="paHwsRefresh" class="primary">刷新</button><button id="paHwsReveal2">打开结果目录</button><span class="lbl">每次「发送」后自动写入本地</span></div>' +
      '      <div class="pa-hws-list" id="paHwsResults"><div class="pa-hws-empty">还没有保存的结果。</div></div>' +
      '    </div>' +
      '    <div class="pa-hws-pane pa-hws-dt" id="paHwsDetail" hidden></div>' +
      '  </div>' +
      '  <div class="pa-hws-foot"><span class="msg" id="paHwsStatus">就绪</span></div>' +
      '</div>';
    root.appendChild(wrap);
    return wrap;
  }

  /* ---------- 面板操作 ---------- */
  var panel = null;
  function $p(sel) { return panel ? panel.querySelector(sel) : null; }
  function setStatus(msg, kind) {
    var e = $p('#paHwsStatus');
    if (!e) return;
    e.textContent = msg;
    e.className = 'msg' + (kind ? ' ' + kind : '');
    if (window.POLARIS_CORE && CORE.setStatus && kind !== 'err') CORE.setStatus(msg, kind || '');
  }
  function show() {
    if (!panel) return;
    panel.hidden = false;
    WS.listScroll = 0;
    WS.view = { mode: 'list', path: '' };
    goList();                    // 每次从顶栏进来都回到目录，不继承上次的详情
    refreshHistory();
  }
  function hide() { if (panel) panel.hidden = true; }

  /* 顶栏「▤ 打开 .http」走这条：只负责弹系统文件对话框，
   * 不再把人推到面板里再点一次「选择 .http 文件」。 */
  function openFromTopbar() {
    var E = window.POLARIS_EDITOR;
    if (E && E.pickAndOpen) { E.pickAndOpen(); return; }
    if (CORE && CORE.setStatus) CORE.setStatus('编辑器还没就绪，稍后再试', 'warn');
  }

  function bind() {
    if (!panel) return;
    $p('.pa-hws-mask').onclick = hide;
    $p('.pa-hws-close').onclick = hide;
    $p('.pa-hws-back').onclick = goList;
    $p('#paHwsReveal2').onclick = revealDir;
    $p('#paHwsRefresh').onclick = refreshHistory;

    /* Esc：详情回目录，目录关面板 —— 与「←」和「×」一一对应，不用记两套规则 */
    document.addEventListener('keydown', function (e) {
      if (!panel || panel.hidden || e.key !== 'Escape') return;
      if (WS.view.mode === 'detail') {
        e.preventDefault(); e.stopPropagation();
        goList();
      } else {
        hide();
      }
    }, true);

    var b1 = document.getElementById('httpFileBtn');
    var b2 = document.getElementById('httpHistoryBtn');
    if (b1) b1.onclick = openFromTopbar;
    if (b2) b2.onclick = show;
  }

  async function loadWs() {
    var snap = await storeGet(ST_KEY);
    if (snap && typeof snap === 'object') {
      WS.workDir = snap.workDir || '';
      WS.resultsDir = snap.resultsDir || '';
    }
  }

  /* ---------- 结果落盘 ---------- */
  async function saveResult(request, response) {
    if (!hostAvailable()) return null;
    try {
      var r = await invokeSafe('http/saveResult', {
        resultsDir: WS.resultsDir || undefined,
        entry: { request: request, response: response }
      });
      return r;
    } catch (e) { setStatus('结果保存失败：' + e.message, 'err'); return null; }
  }

  /* ---------- 历史结果 ---------- */

  /* 把历史结果里每个请求名最近一次的响应载入运行时上下文，
   * 使单条「载入 / 运行」也能解析 {{login.response.body.$.token}}。 */
  function respLite(r) {
    var text = (r && r.text) ? r.text : '';
    var parsed = (r && r.isBase64) ? { ok: false } : CORE.tryJSON(text);
    return {
      status: r ? r.status : 0, headers: (r && r.headers) || {}, text: text,
      parsed: parsed.ok ? parsed.value : undefined
    };
  }
  async function hydrateRuntimeResponses() {
    if (!hostAvailable()) return;
    var seen = {}, count = 0;
    for (var i = 0; i < WS.results.length && count < 30; i++) {
      var it = WS.results[i];
      var key = it.name || it.id;
      if (!key || seen[key]) continue;
      seen[key] = 1; count += 1;
      try {
        var r = await invokeSafe('http/getResult', { path: it.path });
        var e = r.entry || {};
        if (e.request && e.request.name && e.response) WS.runtimeResponses[e.request.name] = respLite(e.response);
      } catch (e2) { /* 忽略损坏的历史文件 */ }
    }
  }

  async function refreshHistory() {
    try {
      var r = await invokeSafe('http/listResults', { resultsDir: WS.resultsDir || undefined });
      WS.results = r.items || [];
      if (r.dir && !WS.resultsDir) WS.resultsDir = r.dir;
      renderResults();
      /* 只更新脚注：自动刷新也会走到这里，别把全局状态栏的「200 OK · 32 ms」顶掉 */
      var f = $p('#paHwsStatus');
      if (f && WS.view.mode === 'list' && !panel.hidden) {
        f.textContent = '历史结果 · ' + WS.results.length + ' 条';
        f.className = 'msg';
      }
      hydrateRuntimeResponses();
      return r;
    } catch (e) {
      var box = $p('#paHwsResults');
      if (box) box.innerHTML = '<div class="pa-hws-empty">' + esc(e.message) + '</div>';
      return null;
    }
  }

  function renderResults() {
    var box = $p('#paHwsResults');
    if (!box) return;
    if (!WS.results.length) { box.innerHTML = '<div class="pa-hws-empty">还没有保存的结果。<br>点「发送」或「运行全部」后会自动写入本地。</div>'; return; }
    box.innerHTML = '';
    WS.results.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'pa-hws-item';
      row.setAttribute('data-path', it.path || '');
      row.innerHTML = '<span class="st ' + statusClass(it.status) + '">' + esc(it.status || '-') + '</span>' +
        '<span class="m">' + esc(it.method || '') + '</span>' +
        '<span class="name">' + esc(it.name || '未命名') + '</span>' +
        '<span class="url">' + esc(fmtTime(it.savedAt)) + ' · ' + esc(msText(it.timeMs)) + ' · ' + esc(kB(it.size)) + '</span>';
      var open = document.createElement('button');
      open.textContent = '打开';
      open.className = 'primary';
      open.onclick = function () { openDetail(it.path); };
      row.appendChild(open);
      var del = document.createElement('button');
      del.textContent = '删除';
      del.onclick = function () { delResult(it.path); };
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  /* ---------- 面板内的两层视图（S8.4） ---------- */
  var MAX_BODY = 400 * 1024;   /* 超出只渲染前面这一截：5 MB 的 JSON 直接进 pre 会卡死面板 */

  function setHead(mode) {
    var back = $p('.pa-hws-back'), badge = $p('.pa-hws-badge');
    if (back) back.hidden = mode !== 'detail';
    if (badge) badge.hidden = mode !== 'detail';
  }
  /* 回到目录：位置、高亮、状态栏文字都复原 */
  function goList() {
    WS.view = { mode: 'list', path: WS.view.path };
    setHead('list');
    var d = $p('#paHwsDetail'), l = $p('#paHwsList');
    if (d) { d.hidden = true; d.innerHTML = ''; }
    if (l) l.hidden = false;
    var scroller = $p('.pa-hws-body');
    if (scroller) scroller.scrollTop = 0;      // 详情可能把外层滚下去了，回目录先归位
    var list = $p('#paHwsResults');
    if (list) list.scrollTop = WS.listScroll || 0;
    markActive();
    setStatus(WS.results.length ? ('历史结果 · ' + WS.results.length + ' 条') : '历史结果');
  }
  function markActive() {
    var list = $p('#paHwsResults');
    if (!list) return;
    var hit = null;
    Array.prototype.forEach.call(list.querySelectorAll('.pa-hws-item'), function (el) {
      var on = WS.view.path && el.getAttribute('data-path') === WS.view.path;
      el.classList.toggle('on', !!on);
      if (on) hit = el;
    });
    /* 目录可能很长：位置已经按 scrollTop 复原，只有「那行确实不在视野里」才补一次
     * （窗口被拉小、或列表在详情期间被刷新过）。无条件 scrollIntoView 会把复原的位置顶掉。 */
    if (hit && hit.scrollIntoView) {
      try {
        var lb = list.getBoundingClientRect(), hb = hit.getBoundingClientRect();
        if (hb.top < lb.top || hb.bottom > lb.bottom) hit.scrollIntoView({ block: 'nearest' });
      } catch (e) { /* 老浏览器忽略参数，位置已经复原了 */ }
    }
  }

  async function openDetail(path) {
    var list = $p('#paHwsResults');
    if (list) WS.listScroll = list.scrollTop;   // 必须在切走之前读，切走就没了
    setStatus('读取历史结果…');
    try {
      var r = await invokeSafe('http/getResult', { path: path });
      var entry = r.entry || {};
      WS.view = { mode: 'detail', path: path };
      renderDetail(entry);
      setHead('detail');
      var l = $p('#paHwsList'), d = $p('#paHwsDetail');
      if (l) l.hidden = true;
      if (d) d.hidden = false;
      var scroller = $p('.pa-hws-body');
      if (scroller) scroller.scrollTop = 0;
      var nm = (entry.request && entry.request.name) || '未命名';
      setStatus('历史快照（只读）· ' + nm + ' · 按 Esc 或「←」回到目录');
    } catch (e) {
      /* 老记录的结果文件可能已被回收（每接口只留最近 10 份）。
       * 这不是故障，别用红字吓人，也别加「打开结果失败」这层前缀。 */
      var msg = String((e && e.message) || e);
      if (msg.indexOf('已回收') >= 0) setStatus(msg, 'warn');
      else setStatus('打开结果失败：' + msg, 'err');
    }
  }

  /* 从「响应区 → 历史」子页跳进来：直接进这条的快照。
   * 这里 **不调 show()** —— show 会重置成目录层并刷新，等于把人推回列表。
   * 目录先静默读一次，这样按「←」回去时列表是满的，这一条还能高亮上。 */
  async function openResultPath(path) {
    if (!path) { setStatus('这条历史只存了摘要（旧版记录没有结果文件），看不到完整响应', 'warn'); return; }
    if (!panel) return;
    panel.hidden = false;
    if (!WS.results.length) { try { await refreshHistory(); } catch (e) { /* 读不到就只显示快照 */ } }
    await openDetail(path);
  }

  function normHeaders(h) {
    var out = {};
    if (!h) return out;
    if (Array.isArray(h)) {
      h.forEach(function (kv) { if (kv && kv.length >= 2 && kv[1] != null && kv[1] !== '') out[String(kv[0])] = String(kv[1]); });
      return out;
    }
    Object.keys(h).forEach(function (k) { if (h[k] != null && h[k] !== '') out[k] = String(h[k]); });
    return out;
  }
  function kvTable(obj) {
    var rows = Object.keys(obj).map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td>' + esc(obj[k]) + '</td></tr>';
    }).join('');
    return '<table class="pa-hws-kv"><tbody>' + rows + '</tbody></table>';
  }
  function utf8Len(s) { try { return new TextEncoder().encode(s).length; } catch (e) { return String(s).length; } }
  function shortFile(p) { return String(p || '').split(/[\\/]/).pop(); }

  /* 一条历史的快照：请求（方法/URL/头/体）+ 响应（状态/头/体）。
   * 只用一处真源，不复制 app.js 的响应渲染：响应体直接借 POLARIS_JV.viewRaw，
   * 这样「高亮 / 换行 / 二进制提示」这些规则与主界面不会各写一套。 */
  function renderDetail(entry) {
    var box = $p('#paHwsDetail');
    if (!box) return;
    var req = entry.request || {}, res = entry.response || {};
    var st = Number(res.status) || 0;
    var ct = res.contentType || '';
    var text = res.text || '';
    var cut = text.length > MAX_BODY;
    var shown = cut ? text.slice(0, MAX_BODY) : text;
    var hReq = normHeaders(req.headers), hRes = normHeaders(res.headers);

    var meta = [
      fmtTime(entry.savedAt),
      msText(res.timeMs),
      kB(res.size),
      ct,
      req.sourceFile ? shortFile(req.sourceFile) : ''
    ].filter(Boolean).map(esc).join(' · ');

    var html = '';
    html += '<div class="pa-hws-dtop">' +
      '<span class="st ' + statusClass(st) + '">' + esc(st || '-') + '</span>' +
      '<span class="m">' + esc(req.method || '') + '</span>' +
      '<span class="dname">' + esc(req.name || '未命名') + '</span>' +
      '</div>';
    html += '<div class="pa-hws-dmeta">' + meta + '</div>';

    html += '<h4>请求</h4>';
    html += '<div class="pa-hws-url"><b>' + esc(req.method || '') + '</b> ' + esc(req.url || '') + '</div>';
    if (Object.keys(hReq).length) {
      html += '<details class="pa-hws-fold"><summary>请求头 · ' + Object.keys(hReq).length + ' 项</summary>' + kvTable(hReq) + '</details>';
    }
    if (req.body) {
      var rb = String(req.body);
      var rbCut = rb.length > MAX_BODY;
      html += '<details class="pa-hws-fold"><summary>请求体 · ' + kB(utf8Len(rb)) + (req.bodyType ? ' · ' + esc(req.bodyType) : '') + '</summary>' +
        '<pre class="raw">' + esc(rbCut ? rb.slice(0, MAX_BODY) : rb) + '</pre></details>';
    }

    html += '<h4>响应</h4>';
    html += '<div class="pa-hws-seg" id="paHwsRespSeg">' +
      '<button data-rp="body" class="on">响应体</button>' +
      '<button data-rp="head">响应头 · ' + Object.keys(hRes).length + '</button>' +
      '</div>';
    html += '<div class="rpane" id="paHwsRespBody"></div>';
    html += '<div class="rpane" id="paHwsRespHead" hidden>' +
      (Object.keys(hRes).length ? kvTable(hRes) : '<div class="pa-hws-empty">（无响应头）</div>') + '</div>';

    html += '<div class="pa-hws-acts">' +
      '<button class="primary" id="paHwsToMain">↗ 在主界面打开</button>' +
      '<button id="paHwsCopyBody">复制响应体</button>' +
      '<span class="hint">这里只读；要改参数重发，请回目录或主界面</span>' +
      '</div>';

    box.innerHTML = html;

    /* 响应体：JSON 给高亮，图片给图，二进制给说明，文本原样 */
    var bodyBox = box.querySelector('#paHwsRespBody');
    if (cut) {
      var note = document.createElement('div');
      note.className = 'pa-hws-note';
      note.textContent = '响应体较大（' + kB(utf8Len(text)) + '），这里只渲染前 ' + kB(MAX_BODY) + '。完整内容请点「在主界面打开」。';
      bodyBox.appendChild(note);
    }
    if (res.isBase64 && /^image\//i.test(ct)) {
      var img = document.createElement('img');
      img.className = 'pa-hws-img';
      img.src = 'data:' + ct + ';base64,' + shown;
      bodyBox.appendChild(img);
    } else if (res.isBase64) {
      var hint = document.createElement('div');
      hint.className = 'pa-hws-empty';
      hint.textContent = '二进制响应（' + (ct || '未知类型') + ' · ' + kB(res.size) + '），这里不展开。';
      bodyBox.appendChild(hint);
    } else if (!shown) {
      bodyBox.innerHTML = '<div class="pa-hws-empty">（响应体为空）</div>';
    } else {
      var JV = window.POLARIS_JV;
      if (JV && JV.viewRaw) {
        bodyBox.appendChild(JV.viewRaw({ text: shown, isBinary: false, contentType: ct, size: res.size }));
      } else {
        var pre = document.createElement('pre');
        pre.className = 'raw';
        pre.textContent = shown;
        bodyBox.appendChild(pre);
      }
    }

    /* 响应体 / 响应头 切换 */
    Array.prototype.forEach.call(box.querySelectorAll('#paHwsRespSeg button'), function (b) {
      b.onclick = function () {
        Array.prototype.forEach.call(box.querySelectorAll('#paHwsRespSeg button'), function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        var isBody = b.getAttribute('data-rp') === 'body';
        box.querySelector('#paHwsRespBody').hidden = !isBody;
        box.querySelector('#paHwsRespHead').hidden = isBody;
      };
    });

    /* 明确地把「进主界面」变成一次点击，而不是「点打开」的副作用 */
    box.querySelector('#paHwsToMain').onclick = function () { sendToMain(entry); };
    box.querySelector('#paHwsCopyBody').onclick = function () {
      var C = window.POLARIS_CORE;
      if (C && C.copy) C.copy(text); else setStatus('当前环境不支持复制', 'warn');
      setStatus('响应体已复制（' + kB(utf8Len(text)) + '）', 'ok');
    };
  }

  /* 用户明确要求进主界面时，才走原来那条路（写进响应区 + 关面板） */
  function sendToMain(entry) {
    var resp = respFromSaved(entry.response || {});
    var A = api();
    if (!A) { setStatus('app.js 尚未就绪', 'err'); return; }
    A.showResponse(resp);
    hide();
    setStatus('已在响应区打开历史结果：' + ((entry.request && entry.request.name) || ''), 'ok');
  }

  async function delResult(path) {
    try {
      await invokeSafe('http/deleteResult', { path: path });
      await refreshHistory();
      setStatus('已删除结果', 'ok');
    } catch (e) { setStatus('删除失败：' + e.message, 'err'); }
  }

  async function revealDir() {
    try {
      await invokeSafe('http/revealDir', { resultsDir: WS.resultsDir || undefined });
      setStatus('已在文件管理器中打开结果目录', 'ok');
    } catch (e) { setStatus('打开目录失败：' + e.message, 'err'); }
  }

  /* ---------- app.js 的响应钩子：每次「发送」自动落盘 ---------- */
  async function onResponse(t, resp, info) {
    if (!resp || resp.error) return;
    var request = {
      name: t.name || '未命名请求',
      method: (info && info.method) || t.method,
      url: (info && info.url) || t.url,
      headers: (info && info.headers) || {},
      body: (info && info.body) || '',
      bodyType: t.bodyType || 'none',
      sourceFile: (t.httpSource && t.httpSource.file) || '',
      /* 直接发（首次调用）时身份还没写进 .http，这里多半是空的；
       * 记进结果文件只为事后追溯，回收分组用的是 name + sourceFile。 */
      interfaceId: (t.httpSource && t.httpSource.interfaceId) || (t.docRef && t.docRef.interfaceId) || ''
    };
    var saved = await saveResult(request, serializableResponse(resp));
    if (saved && resp.url) {
      WS.runtimeResponses[request.name] = resp;
      if (panel && !panel.hidden) refreshHistory();
    }
    return saved;      // app.js 拿它的 path 写进历史行，历史子页才能「详情」
  }

  /* ---------- 取消标志（S6.2） ---------- */
  /* 用户点「停止」时，app.js 往 `<资源目录>/_cancel/<requestId>.flag` 写一笔；
   * 后端每读 64 KiB 看一眼这个文件，看到就断开连接、把已收到的部分带回去。
   * 路径在这里算，不让 app.js 自己拼 —— 与 `_history/` 一样挂在工作区根下，
   * 换分隔符的地方只有一处（Windows 的 `\` 与 POSIX 的 `/` 由 joinPath 处理）。 */
  var CANCEL_DIR = '_cancel';
  function cancelPath(rid) {
    var dir = WS.workDir || '';
    if (!dir || !rid) return '';
    var S = window.POLARIS_STORE;
    var base = (S && S.joinPath) ? S.joinPath(dir, CANCEL_DIR) : String(dir).replace(/[\\/]+$/, '') + '/' + CANCEL_DIR;
    var name = String(rid) + '.flag';
    return (S && S.joinPath) ? S.joinPath(base, name) : base + '/' + name;
  }

  /* ---------- 启动 ---------- */
  async function boot() {
    injectCss();
    panel = buildPanel();
    bind();
    window.POLARIS_HTTP_WS = { onResponse: onResponse, show: show, openResultPath: openResultPath, state: WS, cancelPath: cancelPath };
    if (DBX && DBX.ready) await DBX.ready;
    await loadWs();
    if (hostAvailable()) {
      try {
        var d = await invokeSafe('http/defaultDirs', {});
        if (!WS.resultsDir) WS.resultsDir = d.resultsDir || '';
        /* 与侧栏的「资源目录」保持一致：优先 ~/apifox（default_work_dir），
         * 只有拿不到时才退回用户主目录 —— 两处各扫一个目录，用户会看到两套集合。 */
        if (!WS.workDir) WS.workDir = d.workDir || d.homeDir || '';
      } catch (e) { /* 保留已有配置 */ }
    }
    WS.ready = true;
    if (hostAvailable()) refreshHistory();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
