/* 取消链路自测（S6.1 + S6.2）。运行：node tools/cancel.test.mjs
 *
 * 沙箱里没有 crates.io 上的 dbx-plugin-sdk，Rust 侧没法完整编译，
 * 所以这里**不测运行时**，只把两端的契约钉死：后端必须 64 KiB 分块、
 * 每块前查标志、两条分支（SSE / 普通）都要查、结束时删标志；
 * UI 必须把 requestId 与 cancelPath 传下去，停止时写标志、收尾时删。
 *
 * 真正的端到端（起一个 50 MB 慢速服务、2 秒内断开）在 tools/live-cancel.mjs，
 * 需要先有编译产物，不进 all.mjs。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const RS = read('backend/src/main.rs');
const APP = read('ui/app.js');
const WS = read('ui/http-workspace.js');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

/* handle_request 的函数体（从函数签名到 parse_method 之前） */
function requestBody() {
  const i = RS.indexOf('fn handle_request(');
  const j = RS.indexOf('fn parse_method(', i);
  assert.ok(i > 0 && j > i, 'main.rs 里找不到 handle_request / parse_method');
  return RS.slice(i, j);
}
/* 普通（非 SSE）分支：从 "} else {" 起，到 "(buf, true)" 收尾 */
function plainBranch() {
  const body = requestBody();
  const i = body.indexOf('} else {', body.indexOf('let (bytes, sse_ended)'));
  const j = body.indexOf('(buf, true)', i);
  assert.ok(i > 0 && j > i, '找不到普通分支');
  return body.slice(i, j);
}
/* SSE 分支：从 "if is_sse {" 到上面的 "} else {" */
function sseBranch() {
  const body = requestBody();
  const i = body.indexOf('if is_sse {', body.indexOf('let (bytes, sse_ended)'));
  const j = body.indexOf('} else {', i);
  assert.ok(i > 0 && j > i, '找不到 SSE 分支');
  return body.slice(i, j);
}

/* ---------------- 后端 ---------------- */

ok('S6.1 分块大小是 64 KiB 的常量，不在循环里写魔法数', () => {
  assert.match(RS, /const READ_CHUNK: usize = 64 \* 1024;/);
  assert.match(plainBranch(), /vec!\[0u8; READ_CHUNK\]/);
});

ok('S6.1 普通分支不再 resp.bytes() 一次性读完', () => {
  const b = plainBranch();
  assert.doesNotMatch(b, /resp\.bytes\(\)/, '不许退回整包读');
  assert.match(b, /resp\.read\(&mut tmp\)/);
});

ok('S6.1 普通分支：每块读之前查标志（检查必须在 read 之前）', () => {
  const b = plainBranch();
  const check = b.indexOf('cancel_requested(cancel_ref)');
  const rd = b.indexOf('resp.read(&mut tmp)');
  assert.ok(check > 0, '普通分支没有取消检查');
  assert.ok(check < rd, '取消检查必须在 read 之前，否则读阻塞时永远查不到');
});

ok('S6.1 SSE 分支也查标志（长连接最容易卡住）', () => {
  const b = sseBranch();
  const check = b.indexOf('cancel_requested(cancel_ref)');
  const rd = b.indexOf('resp.read(&mut tmp)');
  assert.ok(check > 0 && check < rd, 'SSE 循环必须同样在 read 前查标志');
});

ok('S6.1 取消后返回已读部分，并标记 cancelled / truncated', () => {
  const body = requestBody();
  assert.match(body, /eprintln!\("\[apifox\] request cancelled at \{\} bytes", bytes\.len\(\)\)/);
  assert.match(body, /"cancelled": cancelled/);
  assert.match(body, /"truncated":/);
});

ok('S6.1 一块都没读到仍按原语义报错（别把网络错误吞成空响应）', () => {
  assert.match(plainBranch(), /if buf\.is_empty\(\)/);
  assert.match(plainBranch(), /format!\("read body: \{e\}"\)/);
});

ok('S6.2 标志只认 .flag，请求结束由 Drop guard 兜底删除', () => {
  assert.match(RS, /fn is_cancel_flag\(p: &Path\) -> bool \{[\s\S]*?eq_ignore_ascii_case\("flag"\)/);
  assert.match(RS, /struct CancelFlagGuard\(Option<PathBuf>\);/);
  assert.match(RS, /impl Drop for CancelFlagGuard \{[\s\S]*?fs::remove_file\(&p\)/);
  assert.match(requestBody(), /let _cancel_guard = CancelFlagGuard\(cancel_path\.clone\(\)\);/);
});

ok('S6.2 发车前先清残留标志（上一轮停止写的那份可能还在）', () => {
  const body = requestBody();
  const clear = body.indexOf('/* 发车前先清一次');
  const guard = body.indexOf('let _cancel_guard');
  assert.ok(clear > 0 && clear < guard, '清理必须发生在构造 guard 之前');
});

ok('S6.2 cancelPath 缺省 / 非法时行为与改动前一致', () => {
  assert.match(requestBody(), /\.filter\(\|p\| is_cancel_flag\(p\)\)/);
  assert.match(RS, /None => false,/);
});

/* ---------------- UI ---------------- */

ok('S6.2 发送时带上 requestId 与 cancelPath', () => {
  assert.match(APP, /const rid='q'\+Date\.now\(\)\.toString\(36\)/, '每次发送要新生成 requestId');
  assert.match(APP, /requestId: rid,/);
  assert.match(APP, /cancelPath: cancelPath \|\| undefined,/);
});

ok('S6.2 停止按钮写标志，且绝不 await（按钮要立刻复原）', () => {
  const i = APP.indexOf('const doStop=()=>{');
  const j = APP.indexOf('btn.onclick = (e)=>', i);
  const body = APP.slice(i, j);
  assert.match(body, /writeCancelFlag\(cancelPath\);/);
  assert.doesNotMatch(body, /await writeCancelFlag/, '停止不能被写文件卡住');
});

ok('S6.2 请求收尾（成功 / 失败 / 停止）都删标志', () => {
  const i = APP.indexOf('}finally{', APP.indexOf('async function send()'));
  const body = APP.slice(i, i + 400);
  assert.match(body, /clearCancelFlag\(cancelPath\);/);
});

ok('S6.2 标志路径由 http-workspace 统一拼，目录叫 _cancel', () => {
  assert.match(WS, /var CANCEL_DIR = '_cancel';/);
  assert.match(WS, /function cancelPath\(rid\)/);
  assert.match(WS, /S\.joinPath\(base, name\)/);
  assert.match(WS, /window\.POLARIS_HTTP_WS = \{ onResponse: onResponse, show: show, openResultPath: openResultPath, state: WS, cancelPath: cancelPath \};/);
  /* app.js 不许自己拼路径 —— 分隔符与资源目录只在 workspace 里有一份真相 */
  assert.doesNotMatch(APP, /['"]_cancel['"]/);
});

ok('S6.2 没有后端时降级为纯逻辑中断（sendSeq 守卫仍在）', () => {
  assert.match(APP, /if\(!p\|\|!DBX\|\|!DBX\.invoke\) return;/);
  assert.match(APP, /t\.stopped\s*\|\|\s*t\.sendSeq\s*!==\s*seq/);
});

console.log('\n' + pass + ' 项通过');
