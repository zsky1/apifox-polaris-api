/* http-file.js 解析与变量求值自测。运行：node tools/http-file.test.mjs */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const H = require('../ui/http-file.js');

const sample = `@baseUrl = https://api.example.com
@token = abc123

### 登录
# @name login
POST {{baseUrl}}/login HTTP/1.1
Content-Type: application/json
Authorization: Bearer {{token}}
Accept: */*

{"user":"admin","pwd":"123"}

> {%
client.test("status is 200", function() { client.assert(response.status === 200); });
client.global.set("authToken", response.body.$.token);
%}

### 取用户列表
GET {{baseUrl}}/users?token={{login.response.body.$.token}}
Accept: application/json

### 上传
POST {{baseUrl}}/upload
Content-Type: application/json

< ./payload.json
`;

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

const parsed = H.parseHttpFile(sample, { fileName: 'demo.http' });

ok('文件级变量', () => {
  assert.equal(parsed.variables.baseUrl, 'https://api.example.com');
  assert.equal(parsed.variables.token, 'abc123');
});
ok('解析出 3 个请求', () => assert.equal(parsed.requests.length, 3));
ok('# @name 覆盖 ### 名称', () => assert.equal(parsed.requests[0].name, 'login'));
ok('请求行含 HTTP/1.1 被剥离', () => {
  assert.equal(parsed.requests[0].method, 'POST');
  assert.equal(parsed.requests[0].url, '{{baseUrl}}/login');
});
ok('Headers 解析', () => {
  const hs = parsed.requests[0].headers;
  assert.equal(hs.length, 3);
  assert.equal(hs[0].k, 'Content-Type');
  assert.equal(hs[1].v, 'Bearer {{token}}');
  assert.equal(hs[2].k, 'Accept');
});
ok('Body 与 bodyType', () => {
  assert.equal(parsed.requests[0].body, '{"user":"admin","pwd":"123"}');
  assert.equal(parsed.requests[0].bodyType, 'json');
});
ok('多行响应脚本与断言计数', () => {
  assert.match(parsed.requests[0].postScript, /client\.global\.set/);
  assert.equal(parsed.requests[0].tests, 1);
});
ok('跨请求引用保留在 URL', () => {
  assert.equal(parsed.requests[1].url, '{{baseUrl}}/users?token={{login.response.body.$.token}}');
});
ok('< 文件引用', () => assert.equal(parsed.requests[2].bodyFromFile, './payload.json'));
ok('未支持语法给出 warnings', () => {
  assert.ok(parsed.warnings.some(w => /仅解析不执行/.test(w)));
});

const ctx = {
  vars: parsed.variables,
  envs: { dev: { envHost: 'dev.example.com' }, prod: { envHost: 'prod.example.com' } },
  activeEnv: 'dev',
  responses: {
    login: { text: '{"token":"T-8899","data":{"id":7}}', headers: { 'X-Trace': 'tr-1' } }
  }
};
ok('普通变量插值', () => assert.equal(H.resolveVars('{{baseUrl}}/users', ctx), 'https://api.example.com/users'));
ok('env 变量插值', () => assert.equal(H.resolveVars('{{envHost}}', ctx), 'dev.example.com'));
ok('跨请求 body JSONPath', () => assert.equal(H.resolveVars('{{login.response.body.$.token}}', ctx), 'T-8899'));
ok('跨请求嵌套 JSONPath', () => assert.equal(H.resolveVars('{{login.response.body.$.data.id}}', ctx), '7'));
ok('跨请求 header', () => assert.equal(H.resolveVars('{{login.response.headers.X-Trace}}', ctx), 'tr-1'));
ok('内置动态变量', () => assert.match(H.resolveVars('{{$timestamp}}', ctx), /^\d{13}$/));
ok('未命中占位符原样保留', () => assert.equal(H.resolveVars('{{nope}}', ctx), '{{nope}}'));
ok('混合插值', () => {
  assert.equal(H.resolveVars('{{baseUrl}}/u?t={{login.response.body.$.token}}', ctx),
    'https://api.example.com/u?t=T-8899');
});

const merged = H.mergeEnvFiles(
  { dev: { host: 'dev', token: 'public' }, prod: { host: 'prod' } },
  { dev: { token: 'secret' } }
);
ok('env 文件合并（private 覆盖）', () => {
  assert.equal(merged.dev.host, 'dev');
  assert.equal(merged.dev.token, 'secret');
  assert.equal(merged.prod.host, 'prod');
});

ok('脚本位于文件顶部不崩溃', () => {
  const r = H.parseHttpFile('{%\nrequest.variables.set("a", "1");\n%}\n\n### first\nGET https://example.com\n');
  assert.equal(r.requests.length, 1);
  assert.match(r.requests[0].preScript, /request\.variables\.set/);
});

ok('空文件与单请求无 ###', () => {
  assert.equal(H.parseHttpFile('').requests.length, 0);
  assert.equal(H.parseHttpFile('GET https://example.com\nAccept: */*\n').requests.length, 1);
});

/* ---------- S1.1 身份注释 ---------- */

ok('带 id：file_id 与 interface_id 都读出来', () => {
  const r = H.parseHttpFile([
    '# @file_id 7f3a9c21  wpa 文件身份',
    '',
    '### 登录',
    '# @interface_id a1b2c3d4  wpa 接口身份',
    'POST https://example.com/login',
    '',
    '{"u":1}',
  ].join('\n'));
  assert.equal(r.fileId, '7f3a9c21');
  assert.equal(r.fileIdLine, 1);
  assert.equal(r.requests[0].interfaceId, 'a1b2c3d4');
  assert.equal(r.requests[0].interfaceIdLine, 4);
});

ok('无 id：fileId 与 interfaceId 都是 undefined，不猜', () => {
  const r = H.parseHttpFile('### 无身份\nGET https://example.com\n');
  assert.equal(r.fileId, undefined);
  assert.equal(r.requests[0].interfaceId, undefined);
});

ok('畸形 id：值太短 / 含非法字符一律忽略并告警', () => {
  const r = H.parseHttpFile('# @file_id ab\n### a\n# @interface_id 中文id\nGET https://example.com\n');
  assert.equal(r.fileId, undefined);
  assert.equal(r.requests[0].interfaceId, undefined);
  assert.ok(r.warnings.some((w) => /@file_id 值不合法/.test(w)));
  assert.ok(r.warnings.some((w) => /@interface_id 值不合法/.test(w)));
});

ok('带说明文字：只取第一个 token，行尾说明丢弃', () => {
  const r = H.parseHttpFile([
    '# @file_id 7f3a9c21  wpa 文件身份，用于关联历史目录',
    '### a',
    '# @interface_id a1b2c3d4  wpa 接口身份，改了等于换身份',
    'GET https://example.com',
  ].join('\n'));
  assert.equal(r.fileId, '7f3a9c21');
  assert.equal(r.requests[0].interfaceId, 'a1b2c3d4');
});

ok('短横线写法与下划线等价', () => {
  const r = H.parseHttpFile([
    '# @file-id 7f3a9c21',
    '### a',
    '# @interface-id a1b2c3d4',
    'GET https://example.com',
  ].join('\n'));
  assert.equal(r.fileId, '7f3a9c21');
  assert.equal(r.requests[0].interfaceId, 'a1b2c3d4');
});

ok('@file_id 写在第一个 ### 之后：忽略不算，且给出可定位的告警', () => {
  const r = H.parseHttpFile('### a\n# @file_id 7f3a9c21\nGET https://example.com\n');
  assert.equal(r.fileId, undefined);
  assert.ok(r.warnings.some((w) => /第 2 行的 @file_id 位于第一个 ### 之后/.test(w)));
});

ok('身份行不会被算进 headers / body', () => {
  const r = H.parseHttpFile([
    '### a',
    '# @interface_id a1b2c3d4',
    'GET https://example.com',
    'Accept: */*',
  ].join('\n'));
  assert.deepEqual(r.requests[0].headers.map((h) => h.k), ['Accept']);
  assert.equal(r.requests[0].body, '');
  assert.equal(r.requests[0].method, 'GET');
});

ok('multipart 表单：parts → body → parts 往返不丢字段（S8.1）', () => {
  const parts = [
    { on: true, name: 'title', kind: 'text', v: '测试标题' },
    { on: true, name: 'audio', kind: 'file', v: 'media/a.wav', filename: 'a.wav' },
    { on: true, name: 'cover', kind: 'file', v: 'C:\\pics\\b.png', filename: 'b.png' },
    { on: false, name: 'skip', kind: 'text', v: '不要发' },
  ];
  const body = H.mpToBody(parts, 'B1');
  const back = H.mpFromBody(body, 'B1');
  assert.equal(back.length, 3, '未启用的行不该进 body');
  assert.deepEqual(back.map((p) => p.name), ['title', 'audio', 'cover']);
  assert.equal(back[0].v, '测试标题');
  assert.equal(back[1].kind, 'file');
  assert.equal(back[1].v, 'media/a.wav');
  assert.equal(back[1].filename, 'a.wav');
  assert.equal(back[1].contentType, 'audio/wav', '文件段要按扩展名补 Content-Type');
  assert.equal(back[2].v, 'C:\\pics\\b.png', '反斜杠路径要原样还原');
  assert.equal(back[2].contentType, 'image/png');
});

ok('multipart 表单：文本值里的换行不会切坏分段，字段名里的引号折成单引号（S8.1）', () => {
  const body = H.mpToBody([{ on: true, name: 'say"hi', kind: 'text', v: '第一行\n第二行' }], 'B2');
  const back = H.mpFromBody(body, 'B2');
  assert.equal(back.length, 1, '值里的换行不该被当成新的分段头');
  /* 已知且有意的损失：`name="..."` 里面不能有裸双引号（会直接切断头部），
   * 写出去时折成单引号，与发送侧 buildMultipart 同一套规则。 */
  assert.equal(back[0].name, "say'hi");
  assert.equal(back[0].v, '第一行\n第二行');
});

ok('multipart 表单：boundary 认 header 优先，其次 body，都没有就兜底（S8.1）', () => {
  assert.equal(H.guessBoundary([{ k: 'Content-Type', v: 'multipart/form-data; boundary=XyZ' }], ''), 'XyZ');
  assert.equal(H.guessBoundary([{ k: 'content-type', v: 'multipart/form-data;boundary="Q 1"' }], ''), 'Q 1');
  assert.equal(H.guessBoundary([], '--FromBody\nContent-Disposition: form-data; name="a"\n\nx\n--FromBody--'), 'FromBody');
  assert.equal(H.guessBoundary([], ''), '');
  const body = H.mpToBody([{ on: true, name: 'a', kind: 'text', v: '1' }], '');
  assert.match(body, /^--ApifoxBoundary$/m, '空 boundary 要兜底成 ApifoxBoundary');
});

/* ===================== WebSocket（S8.5） ===================== */
ok('WS：WEBSOCKET / WS / WSS 三种写法都认，方法归一成 WEBSOCKET', () => {
  const a = H.parseHttpFile('WEBSOCKET ws://h/e\n');
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].method, 'WEBSOCKET');
  assert.equal(a.requests[0].isWs, true);
  assert.equal(a.requests[0].url, 'ws://h/e');

  const b = H.parseHttpFile('WS wss://h/e\n\nhi\n');
  assert.equal(b.requests[0].method, 'WEBSOCKET', 'WS 简写要归一');
  assert.equal(b.requests[0].url, 'wss://h/e');
  assert.equal(b.requests[0].body, 'hi', '空行之后是首条消息');
});

ok('WS：body 之后跟 WEBSOCKET 不再被吞成上一条的 body（S8.5 修的老洞）', () => {
  const r = H.parseHttpFile('### a\nGET http://x/ping\n\nWEBSOCKET ws://h/e\nhello\n');
  assert.equal(r.requests.length, 2, '要切成两条，不是一条带怪 body 的 GET');
  assert.equal(r.requests[0].body, '', 'GET 的 body 必须还是空的');
  assert.equal(r.requests[1].method, 'WEBSOCKET');
  assert.equal(r.requests[1].body, 'hello');
});

ok('WS：=== 分隔多条消息，body 保留第一条，其余进 wsMessages', () => {
  const r = H.parseHttpFile('WEBSOCKET ws://h/e\n\n{"op":"sub"}\n===\n{"op":"ping"}\n');
  const q = r.requests[0];
  assert.equal(q.wsMessages.length, 2);
  assert.equal(q.body, '{"op":"sub"}', 'body 就是第一条（写回文件按它走）');
  assert.equal(q.wsMessages[1], '{"op":"ping"}');
  assert.equal(r.warnings.length, 1, '多条消息要给一条提示');
});

ok('WS：普通 body 里出现方法名不会被误切', () => {
  const r = H.parseHttpFile('### p\nPOST http://x/a\nContent-Type: application/json\n\n{"m":"GET"}\n');
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].body, '{"m":"GET"}');
});

ok('WS：没有首条消息时给提示，不静默', () => {
  const r = H.parseHttpFile('WEBSOCKET ws://h/e\n');
  assert.equal(r.requests[0].body, '');
  assert.match(r.warnings[0], /没有首条消息/);
});

console.log('\n' + pass + ' assertions passed');
