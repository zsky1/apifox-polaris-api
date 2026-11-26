/* mock-host.js — 只给「浏览器里手动点」用的假宿主。
 *
 * 真实插件里 window.dbxPlugin 由 DBX 注入；这里用同一套接口在浏览器里补出来：
 *   invoke  -> POST /__dev/invoke（dev-server.mjs 落到真实磁盘 / 真发请求）
 *   storage -> localStorage（关掉浏览器也还在，方便连续几天接着点）
 *
 * 由 dev-server.mjs 注入到 index.html 的 <head> 里，保证早于 dbx-bridge.js 执行。
 */
(function () {
  var LS_PREFIX = 'wpa-dev:';

  async function call(method, params) {
    var res;
    try {
      res = await fetch('/__dev/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: method, params: params || {} }),
      });
    } catch (e) {
      throw new Error('本地调试服务未响应（' + (e && e.message ? e.message : e) + '）');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* 非 JSON */ }
    if (!res.ok || !data || data.ok !== true) {
      var msg = (data && data.error) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data.result;
  }

  /* 订阅式流：/__dev/invoke 这时回的是 text/event-stream。
   * 每块用 postMessage 冒充宿主转发（source:"dbx-host"），最后一条 `result` 才是返回值。
   * 这与真宿主的 forwardEvent 走同一条路，UI 不需要知道是真是假。 */
  async function callStream(method, params) {
    var res;
    try {
      res = await fetch('/__dev/invoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: method, params: params || {} }),
      });
    } catch (e) {
      throw new Error('本地调试服务未响应（' + (e && e.message ? e.message : e) + '）');
    }
    if (!res.ok || !res.body) throw new Error('流式连接失败：HTTP ' + res.status);
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '', result = null, failure = null;
    for (;;) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        var raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        var name = '', data = '';
        raw.split('\n').forEach(function (line) {
          if (line.indexOf('event:') === 0) name = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
        });
        var obj = null;
        try { obj = JSON.parse(data); } catch (e) { continue; }
        if (name === 'result') result = obj;
        else if (name === 'fail') failure = obj.error || '流式请求失败';
        else window.postMessage({ source: 'dbx-host', version: 1, type: 'event', method: 'apifox/http/stream', params: obj }, '*');
      }
    }
    if (failure) throw new Error(failure);
    if (!result) throw new Error('流式连接结束但没有结果');
    return result;
  }

  var STATE_KEY = LS_PREFIX + 'apifox.state.v2';
  var BOOT_KEY = LS_PREFIX + 'booted';

  /* 首次打开时，把 dev-workspace/http-client.env.json 里的环境灌进初始状态。
   * 真实插件里环境由用户在「管理环境」里建；调试环境直接从文件读，省得每次手填。
   * ui.migratedAt 一起写死，跳过「旧集合迁移」，免得凭空多出一个示例 collection。 */
  async function bootstrap() {
    try {
      if (localStorage.getItem(BOOT_KEY)) return;
      var r = await call('http/readEnvFiles', {});
      var pub = (r && r.public) || {};
      var envs = Object.keys(pub).map(function (name, i) {
        var v = pub[name] || {};
        var vars = Object.keys(v).filter(function (k) { return k !== 'baseUrl'; })
          .map(function (k) { return { id: 'dev-var-' + i + '-' + k, on: true, k: k, v: String(v[k]) }; });
        return { id: 'dev-env-' + (i + 1), name: name, baseUrl: v.baseUrl || '', vars: vars };
      });
      localStorage.setItem(STATE_KEY, JSON.stringify({
        tabs: [], activeTab: null, collections: [], envs: envs,
        activeEnv: envs.length ? envs[0].id : null,
        ui: { migratedAt: Date.now() },
      }));
      localStorage.setItem(BOOT_KEY, '1');
    } catch (e) { /* 读不到就按空环境跑，不影响点 */ }
  }

  window.dbxPlugin = {
    ready: bootstrap(),
    locale: 'zh-CN',
    theme: 'dark',
    context: { debug: true, mock: true },

    invoke: function (method, params) {
      if (method === 'http/request' && params && params.stream && params.streamRequestId) return callStream(method, params);
      return call(method, params);
    },

    setTitle: function (t) { document.title = t || 'apifox'; },

    onContext: function () { /* 调试模式下上下文不变 */ },

    storage: {
      get: async function (key) {
        try {
          var raw = localStorage.getItem(LS_PREFIX + key);
          return raw == null ? null : JSON.parse(raw);
        } catch (e) { return null; }
      },
      set: async function (key, value) {
        try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)); } catch (e) { /* 配额满就丢 */ }
      },
      delete: async function (key) {
        try { localStorage.removeItem(LS_PREFIX + key); } catch (e) { }
      },
    },
  };

  /* 左上角挂一条调试条，提醒这是本地假宿主，别把数据当真 */
  window.addEventListener('DOMContentLoaded', function () {
    var b = document.createElement('div');
    b.textContent = '本地调试宿主 · 文件读写与请求都真跑，数据在 dev-workspace/';
    b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:6px;z-index:99999;' +
      'font:11px/1.6 -apple-system,Segoe UI,sans-serif;color:#a9dcbf;background:rgba(35,134,84,.22);' +
      'border:1px solid rgba(63,185,80,.35);border-radius:999px;padding:2px 12px;pointer-events:none';
    document.body.appendChild(b);
  });
})();
