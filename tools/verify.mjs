/* 交付前静态校验：node tools/verify.mjs
 * 只做契约与接线层面的检查（不启动宿主、不编译 Rust）：
 *   manifest/Cargo 版本一致、脚本引用存在且顺序正确、POLARIS_API 接口齐备、
 *   sidecar 方法与 UI 调用对齐、编辑器关键实现（gutter ▶ / 自动保存 / writeFile）就位。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.1.0';
let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }
function assert(c, m) { if (!c) throw new Error(m); }

ok(`manifest.json 是合法 JSON 且版本为 ${VERSION}`, () => {
  const m = JSON.parse(read('manifest.json'));
  assert(m.manifest_version === 1, 'manifest_version');
  assert(m.version === VERSION, 'version=' + m.version);
  assert(m.id === 'com.zsky1.apifox', 'id');
  assert(m.name === 'apifox-polaris-api', 'name');
  assert(m.publisher === 'zsky1', 'publisher');
  assert(m.entrypoints.backend.executable === 'bin/windows-x64/dbx-plugin-apifox.exe', 'executable');
  assert(m.entrypoints && m.entrypoints.backend && m.entrypoints.ui, 'entrypoints');
  assert(Array.isArray(m.contributions) && m.contributions.length, 'contributions');
  assert(Array.isArray(m.permissions) && m.permissions.includes('host.storage'), 'permissions');
});

ok('Cargo.toml 版本与插件一致', () => {
  assert(new RegExp('version\\s*=\\s*"' + VERSION + '"').test(read('backend/Cargo.toml')), 'Cargo version');
});

ok('Cargo.lock 的包自身版本与 Cargo.toml 一致', () => {
  const lock = read('backend/Cargo.lock');
  const m = lock.match(/name = "dbx-plugin-apifox"\r?\nversion = "([^"]+)"/);
  assert(m, 'Cargo.lock 缺少包条目');
  assert(m[1] === VERSION, `Cargo.lock=${m[1]} 与 Cargo.toml=${VERSION} 不一致（--locked 编译会失败）`);
});

ok('index.html 引用的脚本都存在且顺序正确', () => {
  const html = read('ui/index.html');
  const refs = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]);
  assert(refs.length >= 8, '脚本数量: ' + refs.length);
  refs.forEach(r => assert(fs.existsSync(path.join(root, 'ui', r)), '缺少 ' + r));
  assert(refs.indexOf('http-file.js') < refs.indexOf('http-workspace.js'), 'http-file 应在 workspace 之前');
  assert(refs.indexOf('http-workspace.js') < refs.indexOf('http-editor.js'), 'http-editor 应在 workspace 之后（覆盖按钮绑定）');
  assert(refs.indexOf('workspace-map.js') >= 0, '缺少 workspace-map.js（侧栏映射）');
  assert(refs.indexOf('workspace-map.js') < refs.indexOf('app.js'), 'workspace-map 应在 app 之前（boot 时要用）');
});

ok('编辑器入口与容器已挂载', () => {
  const html = read('ui/index.html');
  ['httpFileBtn', 'httpHistoryBtn', 'http-file.js', 'http-workspace.js', 'http-editor.js']
    .forEach(k => assert(html.includes(k), '缺少 ' + k));
});

ok('所有 ui/*.js 语法可编译', () => {
  const files = fs.readdirSync(path.join(root, 'ui')).filter(f => f.endsWith('.js'));
  files.forEach(f => {
    try { new vm.Script(read('ui/' + f), { filename: f }); }
    catch (e) { throw new Error(f + ': ' + e.message); }
  });
});

ok('app.js 的响应钩子与 POLARIS_API 导出就位（含 runRaw）', () => {
  const s = read('ui/app.js');
  assert(s.includes('window.POLARIS_HTTP_WS') && s.includes('onResponse'), '响应钩子');
  assert(s.includes('window.POLARIS_API'), '导出');
  ['addTab', 'showResponse', 'uid', 'blankRow', 'resolveVars', 'runRaw'].forEach(k => assert(s.includes(k + ':'), '缺少导出 ' + k));
  assert(/runRaw:[\s\S]*?showResponse\(resp\)/.test(s), 'runRaw 必须把结果交给 showResponse（进原响应框）');
});

ok('历史结果面板只读 _results/，不再自己载入或运行请求（S8.3）', () => {
  const s = read('ui/http-workspace.js');
  ['POLARIS_HTTP_WS', 'onResponse', 'refreshHistory', 'listResults'].forEach(k =>
    assert(s.includes(k), '缺少 ' + k));
  /* 文件入口已收口到顶栏「打开 .http」与侧栏映射树；批量运行在浮层「▶▶ 全部运行」。
   * 面板里再留一份「扫描 / 载入为 tab / 运行全部」就是第二套入口。 */
  ['A.addTab', 'paHwsScan', 'paHwsLoadAll', 'paHwsRunAll', 'paHwsDir', 'paHwsPick']
    .forEach(k => assert(!s.includes(k), '面板里不该再有 ' + k));
  assert(/openFromTopbar[\s\S]{0,200}pickAndOpen/.test(s), '顶栏「打开 .http」要直连 pickAndOpen');
  assert(/pa-hws-title">历史结果/.test(s), '面板标题就叫「历史结果」');
});

ok('历史结果面板分两层：目录 ⇄ 快照，点「打开」不再直接跳主界面（S8.4）', () => {
  const s = read('ui/http-workspace.js');
  ['paHwsDetail', 'paHwsList', 'goList', 'openDetail', 'renderDetail', 'markActive', 'sendToMain']
    .forEach(k => assert(s.includes(k), '缺少 ' + k));
  /* 「打开」只切层；进主界面必须由用户再点一次「↗ 在主界面打开」。
   * 原来的写法是 getResult → showResponse → hide()，一点就把面板关掉、把响应塞进主界面，
   * 用户分不清自己是在看历史还是那条历史已经变成主界面的当前响应。 */
  const fn = s.match(/async function openDetail[\s\S]*?\n  \}\n/);
  assert(fn, '找不到 openDetail 函数体');
  assert(!/hide\(\)/.test(fn[0]), 'openDetail 里不许关面板（那正是歧义来源）');
  assert(!/showResponse/.test(fn[0]), 'openDetail 里不许直接写主界面响应区');
  assert(/function sendToMain[\s\S]{0,400}?showResponse/.test(s), '进主界面要走 sendToMain（显式一次点击）');
  assert(/list\.scrollTop = WS\.listScroll/.test(s), '返回目录要恢复滚动位置（目录可能上百条）');
  assert(/scrollIntoView[\s\S]{0,120}?nearest/.test(s), '只有在行确实不可见时才补一次 scrollIntoView');
});

ok('WebSocket：与 HTTP 共用 tab，长连接走事件（S8.5）', () => {
  const file = read('ui/http-file.js');
  assert(/var METHODS = \[[^\]]*'WEBSOCKET'\]/.test(file), '解析器方法表要含 WEBSOCKET');
  assert(/isWs/.test(file), '解析结果要标出 isWs');
  assert(/wsMessages/.test(file), '=== 分隔的多条消息要落地');

  const core = read('ui/core.js');
  assert(/'WEBSOCKET'/.test(core), '方法下拉要能选 WEBSOCKET');

  const app = read('ui/app.js');
  ['renderWsPane', 'onWsEvent', 'wsToggle', 'wsConnect', 'wsClose', 'wsSendText', 'wsAppendFrame']
    .forEach(k => assert(app.includes(k), '缺少 ' + k));
  /* 不新开 tab 类型：WS 用的还是 activeTab / state.tabs */
  assert(!/wsTab|type\s*:\s*['"]ws['"]/.test(app), 'WS 不该另立一种 tab 类型');
  assert(/method==='WEBSOCKET'\)\s*return wsToggle/.test(app), '同一个按钮：WEBSOCKET 下走连接/断开');
  /* 帧要增量 append：整块重建会把滚动位置和正在看的行冲掉 */
  assert(/function wsAppendFrame[\s\S]{0,400}appendChild/.test(app), '帧必须 append，不能整块重建');

  const rs = read('backend/src/main.rs');
  ['"ws/connect"', '"ws/send"', '"ws/close"', '"ws/list"', 'apifox/http/ws']
    .forEach(k => assert(rs.includes(k), '后端缺少 ' + k));
  assert(/set_read_timeout/.test(rs), '读线程要有超时，否则断开后醒不过来');
  assert(/WS_MAX_FRAME/.test(rs), '单帧要有上限（事件通道 8 MiB 硬顶）');
  assert(/tungstenite/.test(read('backend/Cargo.toml')), 'Cargo.toml 要声明 tungstenite');
});

ok('http-editor.js 关键实现就位', () => {
  const s = read('ui/http-editor.js');
  /* 源码编辑 + gutter 运行按钮 + 自动保存 + 结果进原响应框 */
  ['pa-fe-run', 'data-ri', 'runOne', 'runRaw', 'writeFile', 'scheduleSave', 'parseHttpFile']
    .forEach(k => assert(s.includes(k), '缺少 ' + k));
  assert(/LH_RATIO\s*=\s*1\.6/.test(s), 'gutter 行高比例（字号 × 1.6）');
  assert(/function lineH\(fs\)/.test(s), '行高必须按字号推导，不能是死常量');
  assert(/PAD_TOP\s*=\s*10/.test(s), 'gutter 顶部内边距');
  /* 绝不隐藏 .res-region —— 必须保留「原先下面的框」 */
  assert(!/res-region[\s\S]{0,40}display\s*=\s*['"]none/.test(s), '不得隐藏 .res-region');
});

ok('sidecar 具备全部 10 个扩展方法', () => {
  const s = read('backend/src/main.rs');
  ['http/defaultDirs', 'http/listFiles', 'http/readFile', 'http/writeFile', 'http/readEnvFiles', 'http/pickFile',
    'http/saveResult', 'http/listResults', 'http/getResult', 'http/deleteResult', 'http/revealDir',
    'http/request'].forEach(k => assert(s.includes('"' + k + '"'), '缺少 ' + k));
});

ok('结果文件按接口回收：与历史同样留 10 份', () => {
  const s = read('backend/src/main.rs');
  assert(/const RESULTS_KEEP: usize = 10;/.test(s), '默认保留 10 份，与 _history 的 MAX_LINES 对齐');
  assert(/fn prune_results\(/.test(s), '缺少回收函数');
  assert(s.includes('maxKeep'), '需要可覆盖的 maxKeep（0 = 关闭）');
  /* 回收必须写在 rename 之后：这次刚存的结果不能被自己删掉 */
  const iRename = s.indexOf('fs::rename(&tmp, &path)');
  const iPrune = s.indexOf('prune_results(&dir, &name_key, &source_file, keep)');
  assert(iRename > 0 && iPrune > iRename, '回收必须在结果落盘之后');
  /* 同名的两个接口不能互相挤：分组要认 sourceFile */
  assert(/if sf != source_file/.test(s), '分组必须比对 sourceFile，否则不同文件里的同名接口会互删');
  assert(s.includes('"pruned"'), '返回值要带 pruned，便于 UI 与验收脚本确认');
});

ok('dbx-plugin.toml 的 include 覆盖新文件所在目录', () => {
  const s = read('dbx-plugin.toml');
  assert(/include\s*=\s*\[[^\]]*"ui"/.test(s), 'include ui');
  assert(/language\s*=\s*"rust"/.test(s), 'rust backend');
});

ok('侧边栏：请求可重命名、可拖拽跨分组移动', () => {
  const s = read('ui/app.js');
  ['renameSaved', 'moveSaved', 'nextSavedId', 'dragRid'].forEach(k => assert(s.includes(k), '缺少 ' + k));
  assert(s.includes("'rx rr'"), '缺少请求重命名按钮 .rr');
  /* 文件真源（v0.9.0）下跨文件搬段会丢注释，暂停拖拽；实现与样式都还在 */
  assert(/item\.draggable\s*=\s*(true|!DOCS\.enabled)/.test(s), '请求项必须可拖拽');
  assert(s.includes("'drop-before'") && s.includes("'drop-after'"), '缺少插入位置高亮');
  assert(s.includes("'dragging'"), '缺少拖动中样式');
  assert(s.includes('moveSaved(rid,g.id,null)'), '分组头/空白区需支持追加投放');
});

ok('保存弹窗：内联新建分组（不再嵌套模态）+ 名称 trim', () => {
  const s = read('ui/app.js');
  const body = s.slice(s.indexOf('function saveCurrent'), s.indexOf('function openSaved'));
  assert(body.length > 100, '未找到 saveCurrent');
  assert(body.includes('mNewGroup'), '缺少内联新分组输入框 mNewGroup');
  assert(!body.includes('PD.ask('), 'saveCurrent 内不得再嵌套 PD.ask（会清空外层弹窗导致失效）');
  assert(/return false/.test(body), '校验失败需 return false 保持弹窗');
  assert(/\(vals\.mName\|\|''\)\.trim\(\)/.test(body), '名称需 trim 后再用');
});

ok('输入法保护：合成中的 Enter 不当作确认', () => {
  ['ui/app.js', 'ui/dialogs.js'].forEach((f) => {
    const s = read(f);
    assert(/isComposing\s*\|\|/.test(s) || /e\.isComposing/.test(s), f + ' 缺少 isComposing 判断');
  });
});

ok('侧边栏样式：重命名按钮与拖拽态', () => {
  const css = read('ui/app.css');
  ['.req-item .rr', '.req-item.dragging', '.req-item.drop-before', '.req-item.drop-after', '.drop-on']
    .forEach((k) => assert(css.includes(k), '缺少样式 ' + k));
});

ok('README 记录了编辑器能力与限制', () => {
  const s = read('README.md');
  ['.http', '自动保存', '▶', '结果目录', '历史结果', '运行全部', '不执行'].forEach(k => assert(s.includes(k), '缺少 ' + k));
});

ok('v0.4.0：打开（系统对话框）/ 拖入 / 可反复保存 就位', () => {
  const ed = read('ui/http-editor.js');
  ['http/pickFile', 'paFeSaveAs', 'saveAs', 'pickNative', 'dropFiles', 'bindDrop',
    'onDrop', 'matchRegistered', 'writeCopy', 'saveCount'].forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(/doSave\([\s\S]{0,200}!S\.path[\s\S]{0,120}saveAs\(\)/.test(ed), '未绑定磁盘时 doSave 必须转另存为');
  assert(ed.includes("noClobber"), '复制副本需 noClobber 防覆盖');
  const bk = read('backend/src/main.rs');
  assert(bk.includes('fn handle_pick_file'), '缺少 sidecar handle_pick_file');
  assert(/fn native_dialog/.test(bk), '缺少 native_dialog 平台实现');
  /* Ctrl+S 不得在 .http 模式下再触发请求 tab 保存 */
  const app = read('ui/app.js');
  assert(/inEditor[\s\S]{0,80}saveCurrent/.test(app), 'app.js 的 Ctrl+S 需为编辑器让路');
});

ok('S2.5c/S7.5：浮层只剩源码，接口导航全归侧栏', () => {
  const ed = read('ui/http-editor.js');
  const app = read('ui/app.js');
  /* 浮层里不该再有文件列表与被删掉的扫目录 API */
  ['paFeDir', 'paFeList', 'paFeScan', 'paFeNew', 'paFeImport', 'paFeOpen',
    'http/listFiles', 'renderFiles', 'refreshFiles', 'matchScanned'].forEach(k => {
    assert(!ed.includes(k), '浮层里不应再有 ' + k);
  });
  /* S7.5：接口一览也拆掉了 —— 同一份请求列表在侧栏已经按真源排好，浮层里再列一遍是第二份 */
  ['paFeOList', 'paFeOCount', 'paFeSide', 'paFeSideBtn', 'renderOutline', 'trackCaret']
    .forEach(k => assert(!ed.includes(k), '浮层里不应再有 ' + k));
  assert(!/pa-fe-side|pa-fe-oi\b/.test(ed), '浮层左栏样式应整块删除');
  /* 外层点接口 / 切 tab：浮层开着就跳到那一段 */
  assert(app.includes('function followSource'), '缺少 followSource()（表单 → 源码跟随）');
  assert(/followSource\(exist\)/.test(app) && /followSource\(t\)/.test(app), '侧栏与 tab 切换都要跟随');
  assert(/isOpen[\s\S]{0,60}followSource|followSource[\s\S]{0,120}isOpen/.test(app), '浮层关着时不能硬弹出来');
  /* 工作目录改为从映射文件所在目录推导，另存为 / 副本仍要有落点 */
  assert(ed.includes('function workspaceDir'), '缺少 workspaceDir()');
  assert(/workspaceDir\(\)[\s\S]{0,80}POLARIS_DOCS/.test(ed), 'workspaceDir 需回落到映射目录');
  /* 侧栏文件分组要有进源码的入口 */
  assert(app.includes('openSourceForFile'), '缺少侧栏 → 源码入口');
  assert(/openSourceForFile[\s\S]{0,200}openPath/.test(app), 'openSourceForFile 需调 openPath');
});

ok('S2.5d：归位与排序只改映射，请求级拖拽走整段搬移', () => {
  const app = read('ui/app.js');
  const st = read('ui/http-store.js');
  const css = read('ui/app.css');
  const mp = read('ui/workspace-map.js');
  /* 文件归位/排序：落点算下标，走 POLARIS_MAP.moveTo，落盘后重渲染 */
  assert(app.includes('function applyFileMove'), '缺少 applyFileMove()');
  assert(/applyFileMove[\s\S]{0,600}POLARIS_MAP|applyFileMove[\s\S]{0,600}M\.moveTo/.test(app), '归位必须走 POLARIS_MAP.moveTo');
  assert(app.includes('function bindFileDrag'), '缺少文件行拖拽绑定');
  assert(app.includes('function dropIndex'), '缺少 dropIndex（先摘后插的下标）');
  assert(app.includes('root-zone'), '缺少拖回根的投放区 .root-zone');
  /* 拖拽手柄只给文件头：请求行自己有 draggable，套在一起会互相抢 */
  assert(/bindFileDrag[\s\S]{0,300}group-head/.test(app), '文件拖拽手柄应是 .group-head');
  assert(!/item\.draggable\s*=\s*!DOCS\.enabled/.test(app), '请求行不应再按 DOCS.enabled 关掉拖拽');
  /* 请求级：同一文件内整段搬移，跨文件仍拒绝 */
  assert(app.includes('function moveRequestInFile'), '缺少 moveRequestInFile()');
  assert(/moveRequestInFile[\s\S]{0,900}moveSegment/.test(app), '同文件调序需走 store.moveSegment');
  assert(/跨文件/.test(app), '跨文件搬段要给出明确提示');
  assert(st.includes('function moveSegmentText'), '缺少 moveSegmentText()');
  assert(/moveSegmentText[\s\S]{0,1200}prefix/.test(st), '整段搬移必须保留文件头（prefix）');
  assert(/moveSegment:\s*async function/.test(st), 'store 需暴露 moveSegment');
  /* 拖拽视觉：文件行上下半区 + 投放高亮 */
  ['dragging-file', 'drop-before', 'drop-after', 'root-zone'].forEach(k => assert(css.includes(k), '缺少样式 ' + k));
  /* 归位原语仍在（不许另起一套） */
  ['function moveTo', 'function relocate', 'function unregister', 'function addFolder'].forEach(k =>
    assert(mp.includes(k), '映射层缺少 ' + k));
});

ok('S3.1：浮层拖拽走位移，位置落偏好、双击复位', () => {
  const ed = read('ui/http-editor.js');
  /* 位置用 --fe-dx/--fe-dy 位移，不改 left/top（改了宽度会被压变形） */
  assert(/\.pa-fe\{--fe-dx:0px;--fe-dy:0px/.test(ed), '浮层需用 --fe-dx/--fe-dy 记位移');
  assert(/transform:translate\(var\(--fe-dx\),var\(--fe-dy\)\)/.test(ed), '浮层定位应走 translate(dx,dy)');
  assert(ed.includes('function applyFePos'), '缺少 applyFePos()');
  assert(ed.includes('function clampFePos'), '缺少 clampFePos()（拖出窗口要夹回）');
  assert(ed.includes('function bindPaneDrag'), '缺少 bindPaneDrag()');
  assert(/bindPaneDrag[\s\S]{0,2000}requestAnimationFrame/.test(ed), '拖拽需 rAF 合帧');
  assert(/bindPaneDrag[\s\S]{0,1400}setPointerCapture/.test(ed), '拖拽需 setPointerCapture');
  assert(/bindPaneDrag[\s\S]{0,3000}dblclick/.test(ed), '双击标题条应复位');
  /* 标题条里的按钮/下拉不能当拖拽手柄 */
  assert(/isCtl[\s\S]{0,160}closest\('button,select,input/.test(ed), '拖拽应跳过按钮/下拉');
  /* 位置持久化 + 启动恢复 + 布局变化后重夹 */
  assert(/feX:\s*Math\.round\(S\.feX\)/.test(ed), 'feX 需写进偏好');
  assert(/isFinite\(p\.feX\)/.test(ed), '启动时需恢复 feX');
  assert(ed.includes('function reclampFe'), '缺少 reclampFe()（窗口缩放后重夹）');
  assert(/setPointerCapture/.test(ed), '拖拽需 setPointerCapture');
  /* 收起态不许拖：off 时本来也点不到，但状态机要拦住 */
  assert(/pointerdown[\s\S]{0,200}S\.collapsed\) return/.test(ed), '收起态不应起拖');
});

ok('S3.2：字号缩放三层同源，行高随字号推导', () => {
  const ed = read('ui/http-editor.js');
  /* 变量只在 .pa-fe 上定义一处，三层都引用它 */
  assert(/\.pa-fe\{--fe-dx[^}]*--pa-fs:12\.5px;--pa-lh:20px/.test(ed), '.pa-fe 需定义 --pa-fs/--pa-lh');
  assert(/\.pa-fe-text\{[^}]*font-size:var\(--pa-fs\);line-height:var\(--pa-lh\)/.test(ed), 'textarea 字号/行高要走变量');
  assert(/\.pa-fe-hl\{[^}]*font-size:var\(--pa-fs\);line-height:var\(--pa-lh\)/.test(ed), '高亮层字号/行高要走变量');
  assert(/\.pa-fe-l\{height:var\(--pa-lh\);min-height:var\(--pa-lh\)/.test(ed), '高亮层每行高度要走变量');
  assert(/\.pa-fe-ln\{[^}]*height:var\(--pa-lh\);line-height:var\(--pa-lh\)/.test(ed), '行号高度/行高要走变量');
  ['pa-fe-run', 'pa-fe-form', 'pa-fe-fold'].forEach((c) => {
    assert(new RegExp('\\.' + c + '\\{[^}]*height:var\\(--pa-lh\\)').test(ed), c + ' 高度要走变量');
  });
  /* 三层 padding 必须同源，否则首行就错开 */
  assert(/\.pa-fe-text\{[^}]*padding:var\(--pa-pad-top\) 14px var\(--pa-pad-top\) 82px/.test(ed), 'textarea padding 要走变量');
  assert(/\.pa-fe-hl\{[^}]*padding:var\(--pa-pad-top\) 14px var\(--pa-pad-top\) 82px/.test(ed), '高亮层 padding 要与 textarea 同源');

  /* 交互：Ctrl+滚轮（passive:false）+ Ctrl+0 复位 + 12–28 夹取 */
  assert(/addEventListener\('wheel'[\s\S]{0,400}passive: false/.test(ed), 'wheel 必须 passive:false 才能拦住整页缩放');
  assert(/wheel[\s\S]{0,300}e\.ctrlKey \|\| e\.metaKey/.test(ed), '只在 Ctrl/⌘ + 滚轮时改字号');
  assert(/Digit0/.test(ed) || /e\.key !== '0'/.test(ed), 'Ctrl+0 复位');
  assert(/FS_MIN\s*=\s*12, FS_MAX\s*=\s*28/.test(ed), '字号范围应为 12–28');
  assert(ed.includes('function applyFontSize'), '缺少 applyFontSize()');
  assert(/applyFontSize[\s\S]{0,500}--pa-lh/.test(ed), 'applyFontSize 要同时改 --pa-fs 与 --pa-lh');
  assert(/applyFontSize[\s\S]{0,700}S\.gutterSig = ''/.test(ed), '改字号必须让行号签名失效，否则行号不重排');
  assert(/fontSize:\s*S\.fontSize/.test(ed), 'fontSize 需写进偏好');
  assert(/isFinite\(p\.fontSize\)/.test(ed), '启动时需恢复字号');
});

ok('S3.3：身份行配色只认两个键，且有四层视觉标记', () => {
  const ed = read('ui/http-editor.js');
  /* 判定：只认 @file_id / @interface_id，别的元数据一律不算 */
  assert(/mm\[3\] === '@file_id' \|\| mm\[3\] === '@interface_id'/.test(ed), '身份行判定必须只认 @file_id / @interface_id');
  assert(/ctx\.ids\[ctx\.idx\] = 1/.test(ed), '身份行需要记进 ids');
  assert(/kinds: \[\], script: false,\s*\n?\s*ids: \{\}/.test(ed), 'ctx 需要 ids 容器');
  /* 三种返回分支都要带 ids，否则大文件/正常文件取值会报 undefined */
  assert(/return \{ html: html, folds: \[\], byOpen: \{\}, ids: \{\}, plain: true \}/.test(ed), '纯文本分支也要带 ids');
  assert(/return \{ html: html, folds: ctx\.folds, byOpen: byOpen, ids: ctx\.ids, plain: false \}/.test(ed), '正常分支要带 ids');
  /* 四层标记：底色 + 竖线 + 描边加粗 + 行号锚点 */
  assert(/'\.pa-l-id\{position:relative;background:rgba\(163,113,247,\.10\)\}'/.test(ed), '身份行需要有淡底');
  assert(/'\.pa-l-id::before\{[^']*background:var\(--m-patch/.test(ed), '身份行需要有左侧竖线');
  assert(/'\.pa-l-id \.t-meta\{color:var\(--m-patch/.test(ed), '身份键要有独立颜色');
  assert(/'\.pa-fe-ln\.idln\{[^']*font-weight:700/.test(ed), '行号栏锚点需要样式');
  assert(/'\.pa-fe-ln\.idln::before\{[^']*border-radius:50%/.test(ed), '行号栏锚点要有圆点');
  assert(/\[data-dbx-theme="light"\] \.pa-l-id\{/.test(ed), '浅色主题需要单独调底色');
  /* 绘制：高亮层与行号栏都要用上 ids */
  assert(/isId \? ' pa-l-id' : ''/.test(ed), 'paint 需要给身份行加 pa-l-id');
  assert(/isId \? ' idln' : ''/.test(ed), 'renderGutter 需要给身份行行号加 idln');
  assert(/idKeys\.sort\(\)/.test(ed), '行号签名要纳入身份行，否则换文件后锚点残留');
});

ok('v0.5.0：语法着色 + 折叠 就位（接口一览已并入侧栏）', () => {
  const ed = read('ui/http-editor.js');
  /* 跳行与命名还留着：折叠、gutter tooltip、表单认段都用它 */
  ['gotoLine', 'urlTail', 'reqName', 'nameAuto'].forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(/function urlTail\([\s\S]{0,600}slice\(-2\)/.test(ed), 'urlTail 需保留末两段');
  /* 着色 */
  ['.t-sepname', '.t-m-get', '.t-jkey', '.t-jstr', '.t-jnum', '.t-jbool', '.t-jnull', '.t-var']
    .forEach(k => assert(ed.includes(k), '缺少样式 ' + k));
  assert(ed.includes('paFeHl') && ed.includes('hl-on'), '缺少高亮代码层');
  assert(/font-variant-ligatures:none/.test(ed), '高亮层需禁用连字，否则与 textarea 错位');

  /* 高亮层与 textarea 必须逐字同宽：只许改颜色/背景。
   * font-weight / font-style / letter-spacing 都会改 advance，
   * 一旦改宽，看到的位置和光标落点就错开 —— 点哪删哪会删错字。 */
  const hlCss = ed.slice(ed.indexOf('===== 语法着色'), ed.indexOf(".pa-fe-edit{flex:1"));
  assert(hlCss.length > 500, '没截到语法着色那段 CSS');
  assert(!/font-style:italic/.test(hlCss), '高亮层不能用斜体（换字体会改字宽）');
  assert(!/letter-spacing:(?!normal)/.test(hlCss), '高亮层不能改字距（会逐字累积偏移）');
  assert(!/\.pa-fe \.t-[^{]*\{[^}]*font-weight:/.test(hlCss), '高亮层不能用 font-weight，加粗请用描边');
  assert(/-webkit-text-stroke/.test(hlCss), '加粗要用描边模拟（不参与排版）');
  /* @file_id / @interface_id 后面那串值：倾斜只能是 skew（transform 不改 advance），
   * 不许用 font-style —— 换字体会改字宽，就是上一版修掉的那个错位。 */
  assert(/\.pa-l-id \.t-metav\{[^}]*skewX\(/.test(hlCss), '@file_id 后的值要用 skewX 做倾斜');
  assert(!/\.pa-l-id \.t-metav\{[^}]*font-style/.test(hlCss), '@file_id 后的值不能用 font-style（会改字宽）');
  assert(/\.pa-l-id \.t-metav\{[^}]*opacity:\.\d+/.test(hlCss), '@file_id 后的值要比键名淡一档');
  /* # @name 这类元数据注释必须按原行拼回：空格/Tab 一个都不能改 */
  assert(/L\.slice\(lead\.length\)[\s\S]{0,700}mm\[3\]/.test(ed), '元数据注释要用未 trim 的原行匹配');
  assert(ed.includes("sp('t-meta', mm[3]) + esc(mm[4])"), '元数据注释拼接时要把 # 后与键后的空白原样吐回');
  /* 折叠：文档权威 + 折叠时保存必须写全文 */
  assert(ed.includes('function docText()'), '缺少 docText()');
  assert(/doSave[\s\S]{0,900}docText\(\)/.test(ed), 'doSave 必须用 docText()（折叠时不能写投影）');
  ['paFeGinner', 'toggleFold', 'buildView', 'expandFoldsForEdit']
    .forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(!/var content = ta\.value/.test(ed), '落盘内容不能直接取 ta.value');

  /* 解析器：连续 3 个以上 # + 空格/Tab 才是标题 */
  const hf = read('ui/http-file.js');
  assert(/\/\^#\{3,\}\[ \\t\]\+\(\.\+\)\$\/\.exec/.test(hf), '标题正则应为 ^#{3,}[ \\t]+(.+)$');
  assert(hf.includes('nameAuto'), '缺少 nameAuto 标记');
});

ok('v0.5.1：multipart 按字节拼装 + 附件二进制读取', () => {
  const hf = read('ui/http-file.js');
  const ed = read('ui/http-editor.js');
  const rs = read('backend/src/main.rs');
  const app = read('ui/app.js');

  /* 解析器 */
  ['parseMultipart', "cur.bodyType = 'multipart'", 'filePath', 'multipart/form-data; boundary=']
    .forEach(k => assert(hf.includes(k), '解析器缺少 ' + k));
  assert(/!bodyBuf\.length/.test(hf), '< 文件 只在 body 为空时才算整包引用（段内必须保留）');

  /* UI 组装 */
  ['buildMultipart', 'b64ToBytes', 'bytesToB64', 'TextEncoder', 'mimeOf']
    .forEach(k => assert(ed.includes(k), '编辑器缺少 ' + k));
  assert(/\\r\\n\\r\\n/.test(ed), 'multipart 必须用 CRLF 分隔头与内容');
  assert(/headers\['Content-Type'\] = mp\.contentType/.test(ed), 'Content-Type 必须与实际 boundary 对齐');
  assert(/binary: true/.test(ed), '附件必须以 binary 读取');
  assert(app.includes('bodyBase64'), 'runRaw 需透传 bodyBase64');

  /* sidecar */
  assert(/bodyBase64/.test(rs) && /BASE64_STANDARD\s*\.decode/.test(rs), 'sidecar 需支持 base64 原始 body');
  assert(/params\.get\("binary"\)/.test(rs), 'readFile 需支持 binary 参数');
  assert(/fn handle_read_file[\s\S]{0,1200}BASE64_STANDARD\.encode/.test(rs), 'readFile 的 binary 分支需返回 base64');
  assert(/raw_body[\s\S]{0,600}req\.body\(bytes\)/.test(rs), '原始字节 body 必须按 bytes 发送');
});

ok('v0.6.0：.http 浮层 + 右缘悬浮箭头', () => {
  const ed = read('ui/http-editor.js');

  /* 浮层挂到 .work（绝对定位），不再塞进 .req-region */
  assert(/querySelector\('\.work'\)/.test(ed), '浮层必须挂到 .work 下');
  assert(/\.pa-root \.work\{position:relative\}/.test(ed), '.work 需要 position:relative');
  assert(/\.pa-fe\.off\{transform:translate\(calc\(var\(--fe-dx\) \+ var\(--fe-slide/.test(ed), '收起动画仍应走 --fe-slide（S3.1 后带 --fe-dx 偏移）');
  assert(/--fe-slide/.test(ed), '滑出距离需按工作区宽度算');

  /* 三态 + 箭头 */
  ['function collapse(', 'function expand(', 'function exitMode(']
    .forEach(k => assert(ed.includes(k), '缺少 ' + k));
  assert(/\.pa-root \.pa-edge\.on\{/.test(ed), '箭头缺少 .on 展示态');
  assert(/backdrop-filter:blur/.test(ed), '箭头需要磨砂半透明');
  assert(/edgeTop/.test(ed), '箭头位置需要持久化');
  assert(/pointerdown/.test(ed) && /setPointerCapture/.test(ed), '箭头需要可拖动');
  assert(/contextmenu/.test(ed), '箭头右键应彻底关闭');

  /* 点 tab / 侧栏自动收起 + 快捷键归属 */
  assert(/byId\('tabbar'\)[\s\S]{0,200}collapse\(true\)/.test(ed), '点请求 tab 应自动收起浮层');
  assert(/isOpen: function \(\) \{ return S\.open && !S\.collapsed; \}/.test(ed), 'isOpen 只代表浮层当前可见');
  assert(!/pane\.hidden = /.test(ed), '浮层不应再用 hidden 属性（会吃掉动画）');
});

ok('v0.6.1：打开 .http 只弹对话框；启动只挂箭头', () => {
  const ed = read('ui/http-editor.js');

  /* pickAndOpen 不能先 enterMode */
  const pick = ed.slice(ed.indexOf('async function pickAndOpen'),
                        ed.indexOf('async function pickAndOpen') + 1200);
  assert(!/enterMode\(\)/.test(pick.split('catch')[0].split('pickNative')[0] || ''), 'pickAndOpen 弹框前不能展开浮层');
  assert(!/^\s*enterMode\(\);\s*$/m.test(pick.split('pickNative')[0]), 'pickAndOpen 弹框前不能 enterMode');
  assert(/pick\.cancelled\) return/.test(pick), '取消时应直接返回、不动界面');

  /* openPath 支持恢复模式：不展开、不扫描 */
  assert(/async function openPath\(p, opts\)/.test(ed), 'openPath 需要 opts');
  assert(/opts\.restore[\s\S]{0,300}armEdge\(\)/.test(ed), '恢复模式应只挂箭头');
  assert(/function armEdge\(/.test(ed), '缺少 armEdge');
  assert(/\{ restore: true \}/.test(ed), '启动恢复需要传 restore 标记');

  /* S2.5c：展开也不再扫目录 —— 侧栏是唯一文件入口，浮层只读当前文件 */
  assert(!/function expand\(\)[\s\S]{0,600}scan\(\)/.test(ed), '展开时不应再扫描目录');
});

ok('v0.6.2：自带示例 + SSE 流式', () => {
  const ed = read('ui/http-editor.js');
  const sm = read('ui/sample-http.js');
  const rs = read('backend/src/main.rs');
  const app = read('ui/app.js');
  const hf = read('ui/http-file.js');
  const idx = read('ui/index.html');

  /* 示例随包发布 + 引入顺序 */
  assert(/sample-http\.js/.test(idx), 'index.html 需引入 sample-http.js');
  assert(idx.indexOf('sample-http.js') < idx.indexOf('http-editor.js'), '示例要在编辑器之前加载');
  const headings = (sm.match(/^### /gm) || []).length;
  assert(headings === 10, '示例应有 10 节，实际 ' + headings);
  ['GET ', 'POST ', 'multipart/form-data', 'text/event-stream', 'x-www-form-urlencoded',
   '@baseUrl', '@apiBase', 'data: [DONE]', '{{$guid}}', 'response.body.$.',
   /* S8.6：示例里得真有一条 WS，否则「首发用户体验」里这块还是空的 */
   'WEBSOCKET wss://'
  ].forEach(k => assert(sm.includes(k), '示例缺少 ' + k));
  assert(sm.includes('__AUDIO_PATH__'), '示例用占位符注入附件路径');
  assert(/replace\(\/__AUDIO_PATH__\/g, attachPath\)/.test(ed), '写入时替换成本机绝对路径');
  assert(!/sk-[A-Za-z0-9]{20,}/.test(sm), '示例不能夹带真实 Key');
  assert(!/1793933720837243|1776153319097387/.test(sm), '示例不能夹带参考文件里的真实 ID');

  /* 默认位置初始化 */
  assert(/async function ensureDefaultSample/.test(ed), '缺少 ensureDefaultSample');
  assert(/examples\.http/.test(ed), '默认文件名应为 examples.http');
  assert(/noClobber: true/.test(ed), '写示例必须 noClobber，不能覆盖用户文件');
  assert(/ensureDefaultSample\(\)[\s\S]{0,500}openPath\(sample, \{ restore: true \}\)/.test(ed), '示例也要以 restore 方式挂箭头');
  assert(/var sample = await ensureDefaultSample\(\);/.test(ed), '示例应在恢复前就确保存在（老用户也能拿到）');
  assert(/restored = \(await openPath\(prefs\.lastPath, \{ restore: true \}\)\) === true/.test(ed), '上次文件失败要能回落');

  /* SSE 后端 */
  assert(/let wants_sse/.test(rs), '后端需识别 SSE 请求');
  assert(/sse_ms/.test(rs), 'SSE 需要独立的读取上限');
  assert(/resp\.read\(&mut tmp\)/.test(rs), 'SSE 必须流式读，不能一次性 bytes()');
  assert(/sseTruncated/.test(rs), '响应需带 sseTruncated');
  assert(/sseTruncated/.test(app), '前端需展示 SSE 截断状态');

  /* multipart 路径支持变量 + 标题优先 */
  assert(/pathJoin\(base, rv\(p\.filePath\)\)/.test(ed), 'multipart 附件路径要支持变量');
  assert(/title: pendingTitle/.test(hf), '解析器需保留 ### 标题');
  assert(/var ti = String\(\(r && r\.title\)/.test(ed), 'reqName 优先显示标题（gutter 与表单共用）');
});

ok('README 带 .http 操作方式与完整示例', () => {
  const rd = read('README.md').replace(/\r\n/g, '\n');
  assert(/### 怎么用（从打开到跑起来）/.test(rd), 'README 需要「怎么用」操作小节');
  ['打开', '找接口', '跑一条', '跑全部', '收起与找回'].forEach(k => assert(rd.includes(k), '操作小节缺步骤：' + k));
  assert(/### 完整示例：`examples\.http`/.test(rd), 'README 需要完整示例小节');
  assert(/<!-- SAMPLE:BEGIN -->\n```http\n/.test(rd), '示例要放进 http 代码块');
  assert(/<!-- SAMPLE:END -->/.test(rd), '示例代码块缺结束标记');
  assert(/data: \[DONE\]/.test(rd), 'README 示例要含 SSE 的 [DONE]');
  assert(/sync-readme-sample\.mjs/.test(rd), 'README 要说明示例由脚本同步');
});

ok('v0.6.3：打开文件停在第一行', () => {
  const ed = read('ui/http-editor.js');
  const doc = ed.slice(ed.indexOf('function setDoc'), ed.indexOf('function syncScroll'));
  assert(/setSelectionRange\(0, 0\)/.test(doc), 'setDoc 要把光标归零');
  assert(/ta\.scrollTop = 0/.test(doc), 'setDoc 要把滚动归零');
});

ok('图标/文案/署名与上游可区分（apifox-polaris-api 蓝紫标）', () => {
  const svg = read('assets/plugin.svg');
  assert(!/#6d5dfc|#2b6de8/i.test(svg), '图标不能沿用上游的紫蓝渐变');
  assert(/#3b5bdb|#7048e8/i.test(svg), '图标应为 apifox-polaris-api 的蓝紫标');
  const notice = read('NOTICE');
  assert(/misxzaiz/i.test(notice), 'NOTICE 要署名上游作者');
  assert(/v0\.2\.0/.test(notice), 'NOTICE 要写明派生自 v0.2.0');
  assert(/Apache License, Version 2\.0/i.test(notice), 'NOTICE 要声明 Apache-2.0');
  const toml = read('dbx-plugin.toml');
  assert(/include\s*=\s*\[[^\]]*"LICENSE"[^\]]*\]/.test(toml), 'include 要带 LICENSE');
  assert(/include\s*=\s*\[[^\]]*"NOTICE"[^\]]*\]/.test(toml), 'include 要带 NOTICE');
  const m = JSON.parse(read('manifest.json'));
  assert(/fork/i.test(m.description), 'manifest 描述要说明是 fork');
  const store = JSON.parse(read('.dbx-store.json'));
  assert(/community fork/i.test(store.description), '商店描述要说明 community fork');
  assert(/misxzaiz/i.test(store.releaseNotes) && /0\.2\.0/.test(store.releaseNotes), '版本说明要注明派生来源');
  assert(/许可与署名/.test(read('README.md')), 'README 需要「许可与署名」小节');
});

/* ---------- v0.9.0 / M1：文件真源 ---------- */

ok('http-store.js 已接入 index.html 且排在 http-file.js 之后', () => {
  const html = read('ui/index.html');
  const a = html.indexOf('./http-file.js');
  const b = html.indexOf('./http-store.js');
  assert(a > 0 && b > a, 'http-store.js 必须在 http-file.js 之后加载');
  assert(b < html.indexOf('./app.js'), 'http-store.js 必须在 app.js 之前加载');
});

ok('http-store.js 导出 createStore 与段落级 API', () => {
  const src = read('ui/http-store.js');
  ['createStore', 'invokeHost', 'writeRequest', 'writeText', 'locateSegment', 'segIndexOfRequest', 'replaceSegment', 'sanitizeName'].forEach((k) => {
    assert(src.indexOf(k + ':') > 0 || src.indexOf('function ' + k) > 0, '缺少 ' + k);
  });
  assert(/POLARIS_STORE/.test(src), '要挂 window.POLARIS_STORE');
});

ok('解析器认身份：@file_id / @interface_id 只取首个 token', () => {
  const src = read('ui/http-file.js');
  assert(/ID_LINE_RE/.test(src), '缺少身份行正则');
  assert(/@\(file\|interface\)\[_-\]id/.test(src), '正则要同时接受下划线与短横线');
  assert(/interfaceId/.test(src) && /fileId/.test(src), '返回值要带 fileId / interfaceId');
});

ok('序列化器存在，且只被 store/迁移使用（不接管日常保存）', () => {
  const src = read('ui/http-file.js');
  assert(/function serializeRequest/.test(src), '缺少 serializeRequest');
  assert(/function serializeCollection/.test(src), '缺少 serializeCollection');
  const store = read('ui/http-store.js');
  assert(/serializeRequest\(/.test(store), 'store 的段落写回应当用 serializeRequest');
});

ok('sidecar 新增四个文件命令，UI 调用与实现对齐', () => {
  const rs = read('backend/src/main.rs');
  ['http/statFile', 'http/deleteFile', 'http/renameFile', 'http/ensureDir'].forEach((cmd) => {
    assert(rs.indexOf('"' + cmd + '"') > 0, 'main.rs 缺少 ' + cmd);
  });
  const store = read('ui/http-store.js');
  ['http/statFile', 'http/deleteFile', 'http/renameFile', 'http/ensureDir', 'http/listFiles', 'http/readFile', 'http/writeFile'].forEach((cmd) => {
    assert(store.indexOf(cmd) > 0, 'http-store.js 未调用 ' + cmd);
  });
});

ok('M1 测试夹具与四个测试文件齐全', () => {
  ['minimal.http', 'handwritten.http', 'with-ids.http', 'messy.http'].forEach((f) => {
    assert(fs.existsSync(path.join(root, 'tools/fixtures', f)), '缺少夹具 ' + f);
  });
  ['fixtures.test.mjs', 'serialize.test.mjs', 'store.test.mjs', 'migrate.test.mjs', 'project.test.mjs'].forEach((f) => {
    assert(fs.existsSync(path.join(root, 'tools', f)), '缺少测试 ' + f);
  });
});

/* ---------- v0.9.0 / S1.5：侧栏改文件源 ---------- */

ok('侧栏数据源切到资源目录（DOCS 层 + 投影 + 重绑）', () => {
  const s = read('ui/app.js');
  ['initDocs', 'refreshDocs', 'applyDocs', 'patchGroup', 'rebindTabs', 'findDocRequest',
    'saveToDoc', 'saveToDocNew', 'appendToDoc', 'storeReqFromTab', 'scheduleDocsRefresh'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0 || s.indexOf(k + '=') > 0, 'app.js 缺少 ' + k);
  });
  assert(/POLARIS_STORE/.test(s), 'app.js 要用 window.POLARIS_STORE');
  assert(/toLegacyCollections\(/.test(s), '投影层必须被调用');
  assert(/await initDocs\(\)/.test(s), 'initApi 里要 await initDocs()');
});

ok('集合不再写 storage（文件是唯一真源），旧数据只迁移一次', () => {
  const s = read('ui/app.js');
  assert(/if\(!DOCS\.enabled\) snap\.collections/.test(s), 'persist 在文件真源下不得写 collections');
  assert(/migrateFromStorage\(/.test(s), '缺少旧数据迁移调用');
  assert(/ui\.migratedAt/.test(s), '迁移需要幂等标记');
});

ok('store 具备追加 / 删除一段的能力（侧栏保存与删除依赖）', () => {
  const s = read('ui/http-store.js');
  ['appendRequest', 'deleteRequest'].forEach((k) => {
    assert(s.indexOf(k + ':') > 0, 'http-store.js 缺少 ' + k);
  });
  const app = read('ui/app.js');
  assert(/appendRequest\(/.test(app) && /deleteRequest\(/.test(app), 'app.js 未接到 append/delete');
});

ok('侧栏头部只留查看态开关：折叠全部 / 展开全部', () => {
  const html = read('ui/index.html');
  assert(/id="collapseAll"/.test(html) && /id="expandAll"/.test(html), '缺少折叠/展开按钮');
  /* 那排图标（新建/重读/导入/导出）在文件真源下已经冗余，且把标题挤没了 */
  ['newGroup', 'refreshDocs', 'importBtn', 'exportBtn'].forEach((id) => {
    assert(!html.includes('id="' + id + '"'), '顶部图标按钮应已删除：' + id);
  });
  const s = read('ui/app.js');
  assert(/'#collapseAll'/.test(s) && /'#expandAll'/.test(s), '折叠/展开按钮未绑定');
  assert(/function setAllCollapsed/.test(s), 'app.js 缺少 setAllCollapsed');
  /* 纯前端：只改查看态，不写映射文件、不动 .http */
  const i = s.indexOf('function setAllCollapsed');
  const fn = s.slice(i, i + 900);
  assert(!/saveWorkspaceMap/.test(fn), '折叠/展开不能写 wpa-workspace.json');
  assert(!/writeFile|store\.write/.test(fn), '折叠/展开不能碰文件');
  assert(/addEventListener\('focus'/.test(s), '切回窗口仍要自动重扫（手动重读按钮已删除）');
});

/* ---------- v0.9.0 / S2.2：反向刷新 + 冲突 ---------- */

ok('S2.2 反向刷新：干净 tab 同步磁盘，脏 tab 挂冲突', () => {
  const s = read('ui/app.js');
  ['syncTabsWithDocs', 'applyRequestToTab', 'renderConflictBar', 'resolveConflict'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0, 'app.js 缺少 ' + k);
  });
  assert(/syncTabsWithDocs\(\);/.test(s), 'refreshDocs 里要调 syncTabsWithDocs');
  assert(/if\(t\.dirty\)/.test(s) && /t\.docConflict=\{/.test(s), '脏 tab 必须挂冲突标记而不是覆盖');
});

ok('S2.2 写回基线跟着 tab 走（不能拿刚扫出的 mtime）', () => {
  const s = read('ui/app.js');
  assert(/t\.baseMtime/.test(s), '缺少 tab 级 baseMtime');
  assert(/baseMtime:\s*t\.baseMtime!=null\?t\.baseMtime:f\.g\.mtime/.test(s),
    'saveToDoc 的 baseMtime 必须优先用 tab 基线');
  assert(/function setTabDocRef\(t,path,req,mtime\)/.test(s), 'setTabDocRef 要接收 mtime');
  assert(/CONFLICT/.test(s), '缺少 CONFLICT 分支');
});

ok('S2.2 冲突栏 UI：三选一，不做隐式覆盖', () => {
  assert(/id="docConflict"/.test(read('ui/index.html')), 'index.html 缺少冲突栏容器');
  const s = read('ui/app.js');
  ['加载磁盘版本', '保留我的', '稍后'].forEach((k) => assert(s.indexOf(k) > 0, '冲突栏缺少按钮 ' + k));
  const css = read('ui/app.css');
  assert(/\.doc-conflict/.test(css) && /\.rtab \.conflict/.test(css), '缺少冲突栏 / tab 标记样式');
});

ok('S2.2 编辑器：保存前比对 mtime，冲突停手', () => {
  const ed = read('ui/http-editor.js');
  ['markDiskVersion', 'diskChanged', 'renderConflictHint', 'resolveConflict'].forEach((k) => {
    assert(ed.indexOf('function ' + k) > 0, 'http-editor.js 缺少 ' + k);
  });
  assert(/await diskChanged\(\)/.test(ed), 'doSave 必须先比对磁盘版本');
  assert(/S\.loadedText/.test(ed), '需要 loadedText 排除假冲突（mtime 变了但内容一样）');
  assert(/paFeConflict/.test(ed), '缺少编辑器冲突提示条');
  assert(/S\.conflict\)\s*\{[\s\S]{0,120}return false/.test(ed), '有冲突时自动保存必须停手');
});

/* ---------- v0.9.0 / S2.3：双向跳转 ---------- */

ok('S2.3 表单 → 源码：请求栏「</>」+ 编辑器 openAt', () => {
  assert(/id="srcBtn"/.test(read('ui/index.html')), '请求栏缺少 </> 按钮');
  const s = read('ui/app.js');
  ['openSourceForTab', 'openInFormForDoc', 'locateDocRequest'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0, 'app.js 缺少 ' + k);
  });
  assert(/'#srcBtn'/.test(s), '</> 按钮未绑定');
  assert(/POLARIS_EDITOR\.openAt\(/.test(s), '要调编辑器的 openAt');
  assert(/openInSource/.test(s), 'POLARIS_DOCS 要暴露 openInSource');
  const ed = read('ui/http-editor.js');
  ['openAt', 'openInForm', 'ensureFresh'].forEach((k) => {
    assert(ed.indexOf('function ' + k) > 0, 'http-editor.js 缺少 ' + k);
  });
  assert(/openAt: openAt/.test(ed), '编辑器要暴露 openAt');
  /* 同一文件被表单改过：不脏就必须重读，否则跳过去看到的是旧 URL */
  assert(/ensureFresh\(path\)/.test(ed), '同文件跳转前要校验磁盘版本');
});

ok('S2.3 源码 → 表单：gutter ▤（接口一览已移除）', () => {
  const ed = read('ui/http-editor.js');
  assert(/pa-fe-form/.test(ed), 'gutter 缺少 ▤ 入口');
  assert(/openInForm\(fr\)/.test(ed), '▤ 点击未接到 openInForm');
  assert(/openInForm: function/.test(read('ui/app.js')), 'POLARIS_DOCS 要暴露 openInForm');
  /* 认段顺序必须是 id → 行号+方法 → 名称+方法（唯一），不许靠 URL 猜 */
  const s = read('ui/app.js');
  assert(/function locateDocRequest[\s\S]{0,400}interfaceId[\s\S]{0,300}line[\s\S]{0,300}name/.test(s),
    'locateDocRequest 的认段顺序应为 id → 行号 → 名称');
});

/* ---------- v0.9.0 / S2.4：变量统一 ---------- */

ok('S2.4 表单侧不再自己实现一套变量解析', () => {
  const s = read('ui/app.js');
  const fn = s.slice(s.indexOf('function resolveVars(str,t)'), s.indexOf('function resolveVars(str,t)') + 700);
  assert(/POLARIS_HTTP/.test(fn), 'resolveVars 必须复用 http-file.js 的实现');
  assert(/resolveDeep|resolveVars/.test(fn), '要调 resolveDeep/resolveVars');
  assert(/fileVars/.test(fn), '要带文件级变量');
  assert(/envAsVars/.test(s), '缺少 envAsVars（环境 → 变量表）');
  /* 旧实现只认环境，出现「{{baseUrl}} 之外一律原样」的写法即为回退 */
  assert(!/function resolveVars\(str\)\{/.test(s), '旧的单参 resolveVars 应当已经删掉');
});

ok('S2.4 发送链路把 tab 传进 resolveVars', () => {
  const s = read('ui/app.js');
  assert(/resolveVars\(t\.url\.trim\(\),t\)/.test(s), 'URL 求值要带 tab');
  assert(/resolveVars\(r\.v,t\)/.test(s), 'header 值求值要带 tab');
  assert(/body=resolveVars\(t\.body,t\)/.test(s), 'body 求值要带 tab');
});

ok('S2.4 fileVars 跟着 tab 走：打开 / 重绑 / 保存后都对齐', () => {
  const s = read('ui/app.js');
  assert(s.indexOf('function syncTabVars') > 0, '缺少 syncTabVars');
  assert(/function openSaved[\s\S]{0,1300}syncTabVars\(t\)/.test(s), 'openSaved 要同步 fileVars');
  assert(/function setTabDocRef[\s\S]{0,500}syncTabVars\(t\)/.test(s), 'setTabDocRef 要同步 fileVars');
  assert(/function rebindTabs[\s\S]{0,600}syncTabVars\(t\)/.test(s), 'rebindTabs 要同步 fileVars');
  assert(/function fileVarsOf[\s\S]{0,200}group\.fileVars|g\.fileVars/.test(s), 'fileVarsOf 应从投影后的分组取');
});

ok('S2.4 投影层透传 fileVars', () => {
  const store = read('ui/http-store.js');
  assert(/fileVars:\s*c\.fileVars\s*\|\|\s*\{\}/.test(store), 'toLegacyCollections 要带 fileVars（默认空对象）');
});

ok('S2.4 环境以 http-client.env.json 为真源', () => {
  const s = read('ui/app.js');
  ['loadEnvsFromFile', 'saveEnvsToFile', 'envsFromFile', 'envsToFile'].forEach((k) => {
    assert(s.indexOf('function ' + k) > 0, 'app.js 缺少 ' + k);
  });
  assert(/await loadEnvsFromFile\(\)/.test(s), 'initDocs 之后要从文件读环境');
  assert(/function close\(\)\{[\s\S]{0,300}saveEnvsToFile\(\)/.test(s), '环境面板关闭要写回文件');
  assert(/rememberEnv\(/.test(s), '要记住当前环境名，下次启动才找得回来');
});

ok('S2.4 跨请求引用认中文请求名', () => {
  const h = read('ui/http-file.js');
  assert(/\\p\{L\}/.test(h), 'response.body 的正则要用 \\p{L}，否则「登录」这种名字匹配不到');
  assert(/function resolveDeep/.test(h), '缺少 resolveDeep（变量值里套占位符要一次解到底）');
  assert(/resolveDeep:\s*resolveDeep/.test(h), 'resolveDeep 要导出');
});


/* ======================= v1.0.0：身份、历史与示例（M4 + M5） ======================= */
ok('v1.0.0：身份纯函数的五个能力都在，且只在原文上插行', () => {
  const id = read('ui/http-identity.js');
  ['newId', 'insertFileId', 'insertInterfaceId', 'dedupe', 'fingerprint', 'retagInterfaceId'].forEach((k) => {
    assert(id.indexOf('function ' + k) > 0, 'http-identity.js 缺少 ' + k);
  });
  assert(/insertFileId:\s*insertFileId/.test(id), 'insertFileId 要导出');
  assert(/retagInterfaceId:\s*retagInterfaceId/.test(id), 'retagInterfaceId 要导出（S4.6 接回用）');
  assert(/idLine\(kind, id, opts\)/.test(id), '身份行必须带 `# ` 前缀，否则 S3.3 的高亮不生效');
});

ok('v1.0.0：调用历史 10 条上限、轮转、二进制外置、坏行跳过', () => {
  const h = read('ui/http-history.js');
  assert(/MAX_LINES = 10/.test(h), '历史保留条数必须是 10（用户 2026-11-20 拍板）');
  ['appendEntry', 'rotateText', 'rotateFile', 'parseJsonl', 'writeBody', 'ensureGitignore'].forEach((k) => {
    assert(h.indexOf('function ' + k) > 0, 'http-history.js 缺少 ' + k);
  });
  assert(/bodyRef/.test(h) && /bodyEncoding/.test(h), '二进制要外置成 .bin 并记 bodyEncoding');
  assert(/maxBodyBytes/.test(h), '二进制上限要留旋钮（5 MB 等拍板，不许写死）');
  assert(/Object\.create\(null\)[\s\S]{0,120}chains/.test(h) || /var chains/.test(h), '同路径读改写要串行，否则连发会互相踩');
  assert(/findByIdentity/.test(h) && /mergeInto/.test(h) && /reuse: reuse/.test(h), 'S4.6 的索引/合并/接回要齐');
});

ok('v1.0.0：发送链路接历史，且历史失败不拖累请求', () => {
  const app = read('ui/app.js');
  assert(/function recordHistory/.test(app), '缺少 recordHistory');
  assert(/POLARIS_HISTORY\.createHistory/.test(app), 'recordHistory 要建 history');
  assert(/historyWritten/.test(app), '要区分「历史写没写成」，失败只提示一次');
  assert(/bodyBase64:/.test(app), '二进制要把 base64 传下去');
  assert(/resp\.isBinary&&resp\.isBase64/.test(app), '只有真 base64 才外置，别把文本当 base64 写坏');
});

ok('v1.0.0：历史子页 + 接回提示条都挂在界面上', () => {
  const idx = read('ui/index.html');
  const app = read('ui/app.js');
  assert(/data-rv="history"/.test(idx), 'index.html 缺少「历史」子页按钮');
  assert(/id="bHist"/.test(idx), '历史子页要有条数角标');
  assert(/id="idReuse"/.test(idx), '缺少接回提示条 #idReuse');
  assert(/function viewHistory\(t\)/.test(app), '缺少 viewHistory');
  assert(/function askIdReuse\(t,rec\)/.test(app) && /function applyIdReuse\(t\)/.test(app), '接回要「先问后做」两段都在');
  assert(/t\.respView!=='history'/.test(app), '停在历史页时发送不许把视图顶走');
});

ok('v1.0.0：seed 退役，首启只靠磁盘上的示例与 env 文件', () => {
  const app = read('ui/app.js');
  const ed = read('ui/http-editor.js');
  assert(!/function seed\(\)/.test(app), 'app.js 里不该再有 seed()（环境与集合都搬到磁盘）');
  assert(!/示例 · DEMO/.test(app), '不该再有内置的 DEMO 集合（首启只放 examples.http）');
  assert(!/state\.envs\.length\) seed\(\)/.test(app), '启动时不该再种 storage 集合/环境');
  assert(/http-client\.env\.json/.test(ed), 'ensureDefaultSample 要顺带种一份 env 文件');
  assert(/noClobber: true/.test(ed), '示例与 env 都必须 noClobber');
});

ok('v1.0.0：桥接的访问器要真生效（Object.assign 搬不动 getter）', () => {
  const b = read('ui/dbx-bridge.js');
  assert(/Object\.defineProperties\(bridge, Object\.getOwnPropertyDescriptors\(getters\)\)/.test(b),
    'readyOk 等访问器必须用 defineProperties，否则 hostAvailable() 恒假、结果保存与扫描全静默失效');
});

ok('v1.0.0：数据格式冻结（docs/data-format.md 与 v1 字段一一对上）', () => {
  const doc = read('docs/data-format.md');
  const fields = ['v', 'at', 'status', 'ok', 'timeMs', 'size', 'method', 'url', 'urlTemplate',
    'fingerprint', 'contentType', 'interfaceId', 'fileId', 'file', 'name',
    'bodyRef', 'bodyEncoding', 'bodyBytes', 'bodyOmitted'];
  for (const f of fields) assert(doc.includes('`' + f + '`'), '格式文档缺字段：' + f);
  assert(/只加字段、不改语义、不删字段/.test(doc), '三条兼容承诺要写死在文档里');
  assert(/只读展示/.test(doc) && /FUTURE_FORMAT/.test(doc), '更新版本的处理方式要写清');
  assert(/formatVersion/.test(doc) && /_meta\.json/.test(doc), '缺 _meta.json 的说明');

  const h = read('ui/http-history.js');
  assert(/FORMAT_VERSION = 1/.test(h), 'FORMAT_VERSION 必须是 1');
  assert(/v: FORMAT_VERSION/.test(h), '每条历史记录都要带 v');
  assert(/META_NAME = '_meta\.json'/.test(h), '要写 _history/_meta.json');
  assert(/__raw/.test(h), '未知字段靠 __raw 原样保留（不许 parse→stringify 洗掉）');
  assert(/FUTURE_FORMAT/.test(h), '读到更高版本要拒绝追加');

  const app = read('ui/app.js');
  assert(/hist-future/.test(app), '历史页要提示「更新版本写入，只读」');
  assert(/futureFormatVersion/.test(app), '状态栏要能说出是哪个版本');
});

ok('0.9.0：四个版本位一致，自用包脚本与验收清单在位', () => {
  const m = JSON.parse(read('manifest.json'));
  const cargoVer = (read('backend/Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
  const lock = read('backend/Cargo.lock');
  /* Cargo.lock 在 Windows 上可能被 core.autocrlf 检出成 CRLF：分割要认 \r?\n，
   * 否则整份 lock 被当成一个 block，读到的是 lock 自己的 format version。 */
  const block = lock.split(/\r?\n\[\[package\]\]\r?\n/).find((b) => b.includes('name = "dbx-plugin-apifox"')) || '';
  const lockVer = (block.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
  assert(cargoVer === m.version, `Cargo.toml=${cargoVer} manifest=${m.version}`);
  assert(lockVer === m.version, `Cargo.lock=${lockVer} manifest=${m.version}`);
  assert(VERSION === m.version, `verify=${VERSION} manifest=${m.version}`);
  assert(fs.existsSync(path.join(root, 'tools', 'selfuse-pack.mjs')), '缺自用打包脚本');
  assert(fs.existsSync(path.join(root, 'docs', 'self-test-1.0.0.md')), '缺 1.0.0 验收清单');
  assert(read('README.md').includes('v0.9.0'), 'README 版本历史里要有 0.9.0');
});

ok('S3.4：浮层下边界可拖（把手 / 夹取 / 落偏好都在）', () => {
  const ed = read('ui/http-editor.js');
  assert(/pa-fe-grip/.test(ed), '缺下边界把手 DOM');
  assert(/bindFeResize\(\)/.test(ed), '把手没绑事件');
  assert(/function applyFeGrow/.test(ed), '缺统一的高度应用函数');
  assert(/S\.feGrow/.test(ed) && /feGrow:\s*Math\.round/.test(ed), 'feGrow 必须落偏好');
  assert(/feBaseBottom\s*-\s*grow|base\s*-\s*grow/.test(ed), 'bottom 必须由基准减 grow 算出来');
  assert(/maxFeGrow\(base\)/.test(ed) && /S\.feY/.test(ed), '上限要考虑标题条拖过的位移');
  assert(/dblclick/.test(ed) && /resetFeGrow/.test(ed), '双击把手要能复位');
  assert(/\.pa-fe-grip\{[^}]*cursor:ns-resize/.test(ed), '把手要给出可拖的光标');
  assert(/\.pa-fe-grip\.off\{display:none\}/.test(ed), '左右分栏（无处可拉）时把手要能藏起来');
  /* 不许把上下分栏的基准写成 0 —— 那等于默认就铺满 */
  assert(/feBaseBottom = Math\.max\(0, bottom\)/.test(ed), '基准下边界必须来自 layoutLayer 量出来的值');
});

ok('0.9.0 收尾：.bin 封顶 5 MB，停止文案只留「已停止」', () => {
  const app = read('ui/app.js');
  assert(/maxBodyBytes:\s*5\s*\*\s*1024\s*\*\s*1024/.test(app), '.bin 上限必须是 5 MB（协议硬顶 8 MiB ÷ 4/3 ≈ 6 MB，留 20% 余量）');
  const hist = read('ui/http-history.js');
  assert(/TOO_LARGE/.test(hist), '超限必须是「只丢 .bin、行照记」，不能整条丢');
  assert(/MAX_JSON_BYTES/.test(hist) || /8 MiB/.test(hist), '注释里要写清 5 MB 是从 8 MiB 倒推的，别下一个人随手调大');
  /* 停止文案（2026-11-21 拍板 C）：只写「已停止」，不再解释后台 */
  assert(/⏹ 已停止/.test(app), '停止标题必须是「⏹ 已停止」');
  assert(!/已通知后端断开/.test(app), '不许再出现「已通知后端断开」（实现口径，且有过承诺）');
  assert(!/不会再读下去/.test(app), '不许再出现解释性长句');
  const doc = read('docs/data-format.md');
  assert(/5 MB/.test(doc) && /8 MiB/.test(doc), 'data-format 要写清 5 MB 的依据');
});

ok('S6.4 订阅式流：SSE 走事件通道，不再攒到最后', () => {
  const mf = JSON.parse(read('manifest.json'));
  assert((mf.permissions || []).includes('host.events'), 'manifest 必须声明 host.events，否则宿主 forwardEvent 直接丢');

  const rs = read('backend/src/main.rs');
  assert(/const STREAM_EVENT: &str = "apifox\/http\/stream"/.test(rs), '事件名要固定成 apifox/http/stream');
  assert(/fn sse_event_end/.test(rs), '要按事件边界切，不能按任意字节切');
  assert(/emitter\.event\(\s*STREAM_EVENT/.test(rs), '正文块必须经 emitter.event 推出去');
  assert(/"streamed": true/.test(rs), '流式返回体要标 streamed，UI 才知道正文在事件里');
  assert(/phase": "open"/.test(rs), '开流前要有 open 探测，宿主不支持时才好退回老路径');

  const br = read('ui/dbx-bridge.js');
  assert(/bridge\.onEvent\s*=/.test(br), 'dbx-bridge 要暴露 onEvent');
  assert(/d\.source !== "dbx-host"/.test(br) && /d\.type !== "event"/.test(br), '只认宿主的事件消息，别把任意 postMessage 当事件');

  const app = read('ui/app.js');
  assert(/streamRequestId/.test(app) && /stream:\s*true/.test(app), '发送时要带 stream/streamRequestId');
  assert(/DBX\.onEvent\('apifox\/http\/stream'/.test(app), 'UI 要订阅这个事件名');
  assert(/function renderStreamPane/.test(app), '流式视图要单独渲染，别去动正常的响应子页');
  assert(/t\.streamDone/.test(app), '要等 done 事件再定稿（事件与 RPC 响应是两条路）');
  assert(/if\(!p\|\|p\.requestId!==streamId\) return;/.test(app), '多个 tab 同时流时要按 requestId 路由');

  /* 老路径必须还在：宿主不支持事件时能退回，而不是空白 */
  assert(/buf\.len\(\) >= 512 \* 1024/.test(rs), '512 KiB 兜底分支不能删，老宿主还得能看');
});

ok('S7.6 跨平台：SDK 可寻址，路径契约有测试兜着', () => {
  /* Cargo.toml 必须留成**版本依赖**：官方 `dbx-plugin package` 打包时会注入
   * patch.crates-io.dbx-plugin-sdk → 它自带的 sdk-root，并且加 --locked。
   * 改成 path 依赖会让那条 patch「未使用」，cargo 要重写 Cargo.lock，--locked 直接拒绝
   * —— 2026-11-21 v0.9.0 发布首跑五个平台全红就是这个原因。 */
  const ct = read('backend/Cargo.toml');
  assert(/dbx-plugin-sdk\s*=\s*\{\s*version\s*=\s*"0\.1\.0"\s*\}/.test(ct),
    'Cargo.toml 里 dbx-plugin-sdk 要保持版本依赖');
  assert(!/dbx-plugin-sdk\s*=\s*\{\s*path/.test(ct),
    '不能改成 path 依赖：会和 CLI 注入的 patch 打架，--locked 下 lock 写不动');

  const vsdk = read('backend/vendor/dbx-plugin-sdk/Cargo.toml');
  assert(/name = "dbx-plugin-sdk"/.test(vsdk) && /version = "0.1.0"/.test(vsdk), 'vendored SDK 的包名与版本要对得上');
  assert(!/^\[workspace\]/m.test(vsdk), 'vendored SDK 不能带 [workspace]，否则 multiple workspace roots');
  assert(read('backend/vendor/dbx-plugin-sdk/src/lib.rs').length > 20000, 'lib.rs 要被真的带进来');
  assert(/Apache-2\.0/.test(read('backend/vendor/dbx-plugin-sdk/README.md')), 'vendor 目录要写清来源与许可');

  /* 三平台 CI：跑路径契约 + 用仓库内 SDK 编译 sidecar（UI 端到端要 Chromium，留在本地） */
  const wf = read('.github/workflows/cross-platform.yml');
  ['ubuntu-latest', 'windows-latest', 'macos-latest'].forEach((os) =>
    assert(wf.includes(os), 'CI matrix 缺 ' + os));
  assert(/node tools\/all\.mjs/.test(wf), 'CI 要跑 node 测试');
  assert(/cargo build --release --locked/.test(wf), 'CI 要真编译 sidecar，且用 --locked 对齐发布构建');
  assert(/patch\.crates-io\.dbx-plugin-sdk\.path="backend\/vendor\/dbx-plugin-sdk"/.test(wf),
    'CI 编译要指向仓库内的 SDK 副本');

  /* 路径契约测试本身：必须并进 all.mjs，否则 CI 跑了也不会执行它 */
  assert(read('tools/all.mjs').includes('fs-contract.test.mjs'), 'all.mjs 要串上 fs-contract.test.mjs');

  /* 两个修掉的真问题 */
  const wm = read('ui/workspace-map.js');
  assert(/s\.indexOf\('\/\/'\) === 0/.test(wm), 'normSlash 要保住 UNC 的双斜杠');
  assert(/\\.replace\(\/\\\/\{2,\}\/g, '\/'\)/.test(wm) || /replace\(\/\\\/\{2,\}\/g/.test(wm),
    'normSlash 要把重复斜杠折成一个（C:\\work\\\\api 与 C:\\work\\api 是同一个目录）');
  const st = read('ui/http-store.js');
  assert(!/var tmp = path \+ '\.tmp'/.test(st), '原子写的 tmp 名不能是固定的 <path>.tmp，并发写会互踩');

  /* 改名覆盖：必须先把旧目标腾开、失败能回滚，不能直删 */
  const rs = read('backend/src/main.rs');
  assert(/stashed/.test(rs), '覆盖前要把旧目标暂存，失败时挪回来');
  assert(!/fs::remove_file\(&tp\)\.map_err\(\|e\| io_err\("覆盖前删除目标失败"/.test(rs),
    '不许再「先删目标再改名」——那一步失败就把用户文件弄丢了');
});

ok('S8.1 multipart 用表单编辑：字段可选文本/文件，文件只露 basename 但存全路径', () => {
  const H = read('ui/http-file.js');
  ['mpToBody', 'mpFromBody', 'guessBoundary', 'mpBaseName', 'mpMime'].forEach((k) =>
    assert(H.includes(k + ': ' + k) || H.includes(k + ':'), 'http-file.js 缺少导出 ' + k));

  const s = read('ui/app.js');
  assert(s.includes('mpBlank'), '缺少 mpBlank()（multipart 的一行）');
  assert(/mpParts:\[mpBlank\(\)\]/.test(s), 'newTab 要带 mpParts');
  assert(/function multipartBoundaryOf/.test(s), '缺少 multipartBoundaryOf()');
  assert(/function mpPartsToSend/.test(s), '缺少 mpPartsToSend()：表单行 → 发送分段');
  assert(/function mpEditor/.test(s), '缺少 mpEditor()（表单编辑器）');
  /* 类型下拉必须是 text / file 两种，且文件格只显示 basename */
  assert(/\[\[.?text.?,.?.文本.?\],\[.?file.?,.?.文件.?\]\]/.test(s), '类型选择器要提供「文本 / 文件」');
  assert(/mp-file-name/.test(s), '文件格要单独一个显示 basename 的位置');
  assert(/http\/pickFile/.test(s), '选文件必须走 http\/pickFile（系统原生对话框）');
  assert(/function pathForTab/.test(s), '缺少 pathForTab()：附件在 .http 目录下要写相对路径');
  /* 发送必须走字节，不能把附件当文本：bodyBase64 才是原始字节通道 */
  assert(/bodyBase64: bodyBase64 \|\| undefined/.test(s), '发送要带 bodyBase64');
  assert(/POLARIS_EDITOR\.buildMultipart/.test(s), '附件组装要复用浮层那份 buildMultipart，别写第二份');
  /* 两个视图共用 t.body：切进切出都要同步，否则表单改了文本不认 */
  assert(/H\.mpToBody\(t\.mpParts,multipartBoundaryOf\(t\)\);\s*\n\s*markDirty/.test(s) ||
    /t\.body=H\.mpToBody\(t\.mpParts,multipartBoundaryOf\(t\)\)/.test(s),
    '表单改动要写回 t.body');

  /* 投影层别再把 multipart 降级成 text（那会让表单退化成原始文本） */
  const store = read('ui/http-store.js');
  assert(/multipart:\s*'multipart'/.test(store), 'toLegacyCollections 的 bodyTypeMap 要保留 multipart');
  assert(/mpParts:\s*mpParts/.test(store), '投影要把分段带进请求对象');

  /* 编辑器那份组装要能接受外部 baseDir（表单这边没有编辑器状态） */
  const ed = read('ui/http-editor.js');
  assert(/function buildMultipart\(req, rv, opts\)/.test(ed), 'buildMultipart 要接受 opts.baseDir');
  assert(/opts && opts\.baseDir/.test(ed), 'buildMultipart 要优先用调用方给的 baseDir');
  assert(/buildMultipart:\s*buildMultipart/.test(ed), 'buildMultipart 要导出给表单用');
});

ok('Apifox 只读：UI 与后端均不提供任何回写入口', () => {
  const af = read('ui/apifox.js');
  const app = read('ui/app.js');
  const ed = read('ui/http-editor.js');
  const rs = read('backend/src/apifox.rs');

  /* 前端不导出回写钩子，也不挂载写入按钮 */
  assert(!/onApiWritten|onEnvsWritten|onSourceSaved|pushAll/.test(af), 'apifox.js 不得含回写函数');
  assert(!/autoPush|afAuto|afPush|推送本地改动/.test(af), 'apifox.js 不得含自动同步/推送入口');
  assert(!/POLARIS_APIFOX\.onApiWritten|POLARIS_APIFOX\.onEnvsWritten/.test(app), 'app.js 不得调用回写钩子');
  assert(!/POLARIS_APIFOX\.onSourceSaved/.test(ed), 'http-editor.js 不得调用源码回写钩子');
  assert(/只从 Apifox 拉取|只读/.test(af), '配置弹窗要说明插件是只读的');

  /* 后端 RPC 分发不得出现写操作 */
  for (const m of ['createApi', 'updateApi', 'deleteApi', 'createEnvironment', 'updateEnvironment', 'deleteEnvironment', 'importOpenapi']) {
    assert(!new RegExp('"apifox/' + m + '"').test(rs), '后端不得分发 apifox/' + m);
  }
  assert(!/fn mutate_api|fn mutate_environment|fn import_openapi/.test(rs), '后端不得保留写入函数');
  /* 只读入口必须保留 */
  for (const m of ['getApiTree', 'listEnvironments', 'diagnoseSync', 'exportOpenapi']) {
    assert(rs.includes('"apifox/' + m + '"'), '后端必须保留只读入口 apifox/' + m);
  }
});

console.log('\n' + pass + ' checks passed');
