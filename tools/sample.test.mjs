/* 示例 .http 的语法自检：能被解析器完整吃下、10 个请求齐全、multipart 分段正确、且不预置身份。 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
global.window = global;
const H = require('../ui/http-file.js');
require('../ui/sample-http.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

const SAMPLE = window.POLARIS_SAMPLE;
ok(!!SAMPLE && typeof SAMPLE.http === 'string', 'sample-http.js 导出了示例');
const text = SAMPLE.http.replace(/__AUDIO_PATH__/g, 'C:\\apis\\sample-upload.txt');

const doc = H.parseHttpFile(text, { fileName: 'examples.http' });
const reqs = doc.requests || [];
ok(reqs.length === 10, `解析出 10 个请求（实际 ${reqs.length}）`);
ok(doc.warnings.length === 0, '没有解析告警：' + JSON.stringify(doc.warnings));

ok(doc.variables.baseUrl === 'https://httpbin.org', '@baseUrl 变量');
ok(doc.variables.apiBase === 'https://api.example.com', '@apiBase 变量');
ok(/sample-upload\.txt$/.test(doc.variables.audioPath || ''), '@audioPath 指向示例附件');

const methods = reqs.map(r => r.method);
ok(JSON.stringify(methods) === JSON.stringify(['GET', 'POST', 'POST', 'POST', 'POST', 'GET', 'GET', 'GET', 'GET', 'WEBSOCKET']),
  '方法序列 ' + methods.join(','));

const names = reqs.map(r => r.title || r.name);
ok(names.every(n => n && !/^https?:/.test(n)), '每条都有标题：' + names.join(' | '));
ok(reqs[0].title === '1. GET · 查询串 + 鉴权头', '标题取自 ### 后的文字');
ok(reqs[0].name === 'listTasks', '@name 保留作跨请求引用键');
ok(reqs[1].title === '2. POST · JSON 体 · 对话补全（OpenAI 兼容那一套）', '含符号的标题完整');

/* GET 带查询串 */
ok(/familyId=1900000000000001/.test(reqs[0].url), 'GET 查询串完整');

/* POST JSON body */
const jsonBody = reqs[1];
ok(jsonBody.bodyType === 'json' && /"stream": false/.test(jsonBody.body || ''), 'JSON 请求体识别为 json');
ok(/userData/.test(jsonBody.body || ''), 'JSON 里含序列化过的 userData 字段');

/* 表单 */
const form = reqs[2];
ok(form.bodyType === 'form', '表单识别为 form，实际 ' + form.bodyType);
ok(/grant_type=password/.test(form.body || ''), '表单内容是 urlencoded');
ok((form.headers || []).some(h => /^content-type$/i.test(h.k) && /x-www-form-urlencoded/.test(h.v)), '表单 Content-Type 正确');

/* multipart */
const mp = reqs[3];
ok(mp.bodyType === 'multipart', 'multipart 识别成功，实际 ' + mp.bodyType);
ok(mp.multipart && mp.multipart.boundary === 'ApifoxBoundary', 'boundary 正确');
ok(mp.multipart && mp.multipart.parts.length === 3, '3 个分段（audio/scene/meta）');
const audio = (mp.multipart.parts || []).find(p => p.name === 'audio');
ok(!!audio && audio.filePath === '{{audioPath}}', 'audio 分段引用 @audioPath 变量');
ok(!!audio && /audio\/wav/.test(audio.contentType || ''), 'audio 分段 Content-Type');
const meta = (mp.multipart.parts || []).find(p => p.name === 'meta');
ok(!!meta && /"sampleRate":16000/.test(meta.content || ''), 'meta 分段是 JSON 文本');

/* SSE */
const sse = reqs[4];
ok((sse.headers || []).some(h => /^accept$/i.test(h.k) && /text\/event-stream/.test(h.v)), 'SSE 请求声明 Accept: text/event-stream');
ok(/"stream": true/.test(sse.body || ''), 'SSE 请求体 stream:true（OpenAI 风格）');
ok(/data: \[DONE\]/.test(text), '注释里写明 data: [DONE] 收尾');
ok(/"delta"/.test(text), '注释里写明增量 delta 形态');

/* 跨请求引用 */
ok(/\{\{login\.response\.body\.\$\.form\.username\}\}/.test(reqs[6].url), '跨请求引用 body 字段');
ok(/\{\{listTasks\.response\.headers\.X-Amzn-Trace-Id\}\}/.test(reqs[6].url), '跨请求引用响应头');

/* 动态变量 */
ok(/\{\{\$guid\}\}/.test(reqs[7].url) && /\{\{\$timestamp\}\}/.test(reqs[7].url) && /\{\{\$randomInt\}\}/.test(reqs[7].url), '动态变量齐全');

/* 第 9 节：环境切换，不改文件就能换后端 */
ok(reqs[8].title === '9. 环境切换 · 变量放哪儿说了算', '第 9 节标题：' + reqs[8].title);
ok(/\{\{baseUrl\}\}\/get\?env=\{\{envTag\}\}/.test(reqs[8].url), '第 9 节用只写在 env 文件里的 {{envTag}}');
ok(/\{\{envTag\}\}/.test(reqs[8].url) && !/^\s*@envTag/m.test(text), 'envTag 确实没有在文件里定义（否则切环境不会有差别）');

/* 第 10 节：WebSocket —— 示例里必须真有一条，否则首次打开的人看不到这个能力 */
ok(reqs[9].title === '10. WebSocket · 连上就发 + 多条消息', '第 10 节标题：' + reqs[9].title);
ok(reqs[9].method === 'WEBSOCKET' && reqs[9].isWs === true, '第 10 节解析为 WEBSOCKET');
ok(/^wss:\/\//.test(reqs[9].url), 'WS 地址是 wss://');
ok(/Sec-WebSocket-Protocol/i.test((reqs[9].headers || []).map(h => h.k).join(',')), '示例演示了握手头');
ok(/"type":"hello"/.test(reqs[9].body || ''), '空行后那条是「连上就发」的首消息');
ok(doc.warnings.length === 0, '示例本身不该带告警（多消息写法只写在注释里）');

/* 9 节各带 1–2 行导语：每个 ### 前面（含紧跟其后的注释）至少有一句说明 */
{
  const blocks = text.split(/^### /m).slice(1);
  const noIntro = blocks.map((b, i) => ({ i, b })).filter(({ b }) => !/^#\s+\S/m.test(b.split('\n').slice(1, 4).join('\n')));
  ok(blocks.length === 10 && noIntro.length === 0, '10 节每节都有导语，缺的是：' + noIntro.map((x) => x.i + 1).join(','));
}

/* 不预置身份：文件里可以「提到」这两个键（第一节就是讲它们），但解析结果不能有 id */
ok(doc.fileId === undefined || doc.fileId === null || doc.fileId === '', '示例里没有预置 @file_id：' + doc.fileId);
ok(reqs.every((r) => !r.interfaceId), '示例里没有预置 @interface_id：' + reqs.map((r) => r.interfaceId).join(','));
ok(!/^\s*#\s*@(file|interface)_id\s+[0-9a-z]{6,}/mi.test(text), '没有一行长得像真身份（只会出现在说明文字里）');
ok(/@file_id/.test(text) && /@interface_id/.test(text), '第一节确实讲了这两个键是什么');

/* 变量解析后 URL 不带 {{ */
const vars = doc.variables;
const ctx = { vars, envs: {}, activeEnv: '', responses: {} };
const u1 = H.resolveVars(reqs[0].url, ctx);
ok(!/\{\{/.test(u1) && u1.startsWith('https://httpbin.org/get?'), '变量解析后 URL 干净：' + u1);

/* 不夹带真实凭据 */
ok(!/sk-[A-Za-z0-9]{20,}/.test(text), '没有夹带真实 API Key');
ok(!/1793933720837243|1776153319097387/.test(text), '没有夹带参考文件里的真实 ID');
ok(!/[A-Za-z0-9]{40,}/.test(text.replace(/\s+/g, '')), '没有夹带长串 token');

/* README / 版本字段存在 */
/* 用脚本自身位置定位仓库根，别依赖 cwd（在别处调用时会误判） */
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
ok(fs.existsSync(path.join(ROOT, 'ui', 'sample-http.js')), '示例文件随包发布');
ok(fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8').includes('sample-http.js'), 'index.html 已引入示例');

/* README 里贴的那份必须和这份一字不差（docs 与包内实现不许走偏） */
{
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = readme.match(/<!-- SAMPLE:BEGIN -->\n```http\n([\s\S]*?)\n```\n<!-- SAMPLE:END -->/);
  ok(!!m, 'README 里有 SAMPLE 代码块标记');
  const inReadme = (m ? m[1] : '').replace(/\s+$/, '');
  const fromSrc = String(SAMPLE.http).replace(/__AUDIO_PATH__/g, 'D:\\音频\\sample-upload.txt').replace(/\s+$/, '');
  ok(inReadme === fromSrc, 'README 示例与 ui/sample-http.js 一致（改示例后跑 tools/sync-readme-sample.mjs）');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
