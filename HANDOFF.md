# 交接单 · apifox-polaris-api v0.9.0 → 1.0.0

> 这份文档是给"另一台电脑上的新会话"看的。**它没有上一轮的对话记忆**，
> 所有判断依据都在这里和 `docs/plan-v1.0.0.md` 里。读完这份就能接着干活。
>
> 生成时间：2026-11-21 02:05（M6 收官 + S7.1 格式冻结）

---

## 0. 一句话现状

1.0.0 的 **M1–M6 全部完成**，`S2.5a/b/c/d + S2.6 + S3.1–3.4 + S4.1–4.6 + S5.1–5.4 + S6.1–6.3 + S7.1` 全绿，
**下一步是 S7.2（版本位齐改到 1.0.0）→ S7.3 出包 → S7.4 商店 PR**。
M6 于 2026-11-21 收官：响应体改 64 KiB 分块读、点停止写 `_cancel/<requestId>.flag`、
后端在下一块之前收手——50 MB 下载中途停止，**160 ms 断开**，只带回已收到的 3 MB。
S7.1 于同日收官：**数据格式冻结成 v1**，写在 `docs/data-format.md`；jsonl 每行首字段 `v`、
`_history/_meta.json` 只建不覆盖、读到更高版本只读展示并且一行都不追加。
S3.4 于同日补上（自用验收反馈）：**浮层下边界可拖**——把手往下拖就吃掉响应区，最多铺满 `.work`，
双击复位、拉开量落偏好；左右分栏时把手自动隐藏。
S6.4 同日收官：**SSE 改成订阅式流**。后端每切出一个完整事件就用 `polaris/http/stream` 推给 UI，
走宿主 `host.events` → iframe `postMessage`，单条几 KB、**总量不受 8 MiB 单消息上限约束**；
界面边收边画（实测 DeepSeek 首块 108 ms、62 块陆续到），「10 秒 / 512 KiB」两道墙没了。
老宿主不转发事件时自动退回一次性返回，不会空白。

**0.9.0 自用包已就绪（2026-11-21）**：`node tools/selfuse-pack.mjs` 摊出 `dist/polaris-0.9.0-<os>-<arch>/`
（manifest + ui/ + bin/），有官方 CLI 再跑 `dbx-plugin package .` 出 `.dbxp`。
验收清单在 **`docs/self-test-0.9.0.md`**（7 节，标 ★ 的必走）。
用户已定：**先跑 0.9.0 自用验收，S7.2 暂缓**，验收完再一次性改 1.0.0。

> ⚠ 这批里挖出一个**躺了很久的真 bug**并修了：`ui/dbx-bridge.js` 用 `Object.assign` 搬访问器，
> 导致 `readyOk` 永远是 `false`，`http-workspace` 的 `hostAvailable()` 恒假 ——
> 「结果保存到 `_results/`」和「目录扫描」整条链路其实一直是死的（演示站跑了几十次请求，`_results/` 是空的）。
> 现在改成 `Object.defineProperties`。**如果哪天有人把这段改回去，`verify.mjs` 会红。**

> ✅ **Rust 侧这次真编译过了**（此前一直以为沙箱没有 cargo）：
> `dbx-plugin-sdk` 不在 crates.io 上，用 `--config patch.crates-io.dbx-plugin-sdk.path=...`
> 指向从 GitHub 拉的 SDK 源码（只有 serde/serde_json 两个依赖）即可 `cargo check/build/clippy`。
> crates.io 直连只有 ~12 KB/s，换 USTC 镜像后 17 秒跑完。

---

## 1. Mac 上怎么接上（按顺序做）

```bash
# 1) 先确认 node 够新（无 npm 依赖，只用内置模块；但 node:test 需要 18+）
node -v        # 需要 >= 18，建议 22

# 2) 在 WorkBuddy 里新建一个任务（会自动生成 ~/WorkBuddy/<日期时间>/ 目录），
#    把 zip 里的这三个目录解压到该工作区根下，保持同级：
#      apifox-polaris-api/   verify-ui/   dev-workspace/
#    再把 .workbuddy/memory/ 解压到该工作区的 .workbuddy/ 下
#    （Mac 上双击用「归档实用工具」解压即可；包内中文文件名的 UTF-8 标志已校验过）

# 3) 自检：应当全绿，且 git 历史完整（最新一条是 S7.1 格式冻结）
cd apifox-polaris-api
git log --oneline | head -3      # 最新一条应是 S7.1 数据格式冻结
git status --short               # 应为空（或只有 HANDOFF.md）
node tools/all.mjs               # 14 个文件全绿

# 4) 起本地调试环境，浏览器打开 http://127.0.0.1:8899
node dev/dev-server.mjs
```

**为什么必须保持 `apifox-polaris-api` 与 `verify-ui` 同级**：
`verify-ui/check-*.mjs` 里写的是 `path.resolve(..., '..', 'apifox-polaris-api')`，
靠的是相对位置，不是绝对路径。

> **⚠ 仓库里没有的东西**：`verify-ui/`（二十一个端到端脚本）和 `dev-workspace/` 一直放在项目目录**外面**，
> 从来没进过 `zsky1/apifox-polaris-api`。所以：
> - 只想接着写代码 / 跑 `node tools/all.mjs` → `git clone` 就够，什么都不缺；
> - 要跑真浏览器验收（`check-s25*.mjs`）→ 得从迁移包 `polaris-handoff-20261121-r15.zip` 里
>   取 `verify-ui/` 和 `dev-workspace/`，放到与 `apifox-polaris-api` 同级。
>   `dev-workspace` 缺失时代码会自己种一份，只是侧栏初始状态跟现在不同。

**新会话开场白建议直接说**：
> 读 `apifox-polaris-api/HANDOFF.md` 和 `docs/plan-v1.0.0.md`，从 M6 的 S6.1 开始。口径不许改。

---

## 2. 硬口径（用户纠正过两次，不可回退）

这三条是这一轮反复被强调的，**任何"改进"都不能破坏**：

1. **目录树 = 映射文件的渲染。只认 `wpa-workspace.json`，一个目录都不扫。**
   磁盘上有但没登记的文件不显示，也不做"发现未登记"。
2. **打开 `.http` 这个动作本身就是挂载。** `openPath` 读成功后追加登记（`POLARIS_DOCS.register`），
   这是往侧栏加文件的**唯一**途径。不要造"资源文件夹""扫描导入"之类的东西。
3. **初始 demo 必须一开机就在侧栏里。** `ensureDefaultSample` 两个分支都要 register
   （包括老用户有 `prefs.lastPath`、走不到 `openPath(sample)` 的那条分支）。

映射文件只记「路径 → 归属文件夹 + 顺序」，不记请求/名字/内容 —— 它丢了最多让文件从侧栏消失，
文件本身不受影响。**这是安全边界，别往映射里塞冗余数据。**

---

## 3. 已完成（别再重做）

| 里程碑 | 状态 | 落点 |
|---|---|---|
| S6.3 取消回归 | ✅ | `tools/live-cancel.mjs` 在**真二进制**上跑四条：512 KiB 二进制响应 SHA-256 一致、784 KiB 上传体 SHA-256 一致（等价那支 wav）、SSE 11 事件完整、`/hang` 超时 816 ms 仍报错。11 项 |
| S6.2 UI 写标志 | ✅ | `http-workspace.js` 新增 `cancelPath(rid)`（`<资源目录>/_cancel/<rid>.flag`，路径只在这一处拼）；`app.js` 每次发送生成 `rid='q'+base36`，随 `requestId`/`cancelPath` 传给后端；`doStop` 里 `writeCancelFlag()` **不 await**（按钮立刻复原），`finally` 里 `clearCancelFlag()`。没有后端时自动退化为纯逻辑中断。`verify-ui/check-s61.mjs` 20 项 |
| S6.1 后端分块读 | ✅ | `backend/src/main.rs`：`READ_CHUNK = 64 KiB`，SSE 与普通两条分支都在**每次 read 之前**查 `cancel_requested()`；`CancelFlagGuard` 在函数返回（含 panic 前）删标志；发车前先清残留标志；返回体新增 `cancelled` / `truncated`。50 MB 中途停止 ≈ 160 ms 断开。`tools/cancel.test.mjs` 14 项 + `tools/live-cancel.mjs` 11 项 |
| S1.0–S1.5 文件真源 | ✅ | `ui/http-file.js` `ui/http-store.js` `app.js` 的 DOCS 层 / 投影层 |
| S2.1 段落级写回 | ✅ | `locateSegment`，只改目标字段，其余字节不变 |
| S2.2 反向刷新 + 冲突 | ✅ | `syncTabsWithDocs` + `baseMtime` + `#docConflict` |
| S2.3 双向跳转 | ✅ | `</>` 表单→源码，`▤` 源码→表单 |
| S2.4 变量统一 | ✅ | 表单侧改走 `POLARIS_HTTP.resolveDeep`；环境以 `http-client.env.json` 为真源 |
| S2.5a 映射层 | ✅ | `ui/workspace-map.js`（`POLARIS_MAP`），无任何扫目录函数 |
| S2.5b 侧栏文件夹树 | ✅ | `renderSidebarMapped / renderFolderNode / renderMapFile` |
| S2.5c 浮层去文件树 | ✅ | 浮层只剩「接口一览 + 源码」，顶栏「≡ 接口一览」是唯一开关 |
| S2.5d 归位与排序 | ✅ | 文件行拖拽：文件夹头归入 / 上下半区插前后 / 根区退回根，全走 `POLARIS_MAP.moveTo` + `saveWorkspaceMap()`，只改映射不动文件；请求级同文件调序 = 整段搬移（`store.moveSegment`），跨文件仍留 1.0.1。`verify-ui/check-s25d.mjs` 23 项 |
| S3.3 身份行配色 | ✅ | `# @file_id` / `# @interface_id` 四层标记：紫淡底 + 左 2px 竖线 + 键斜体加粗 + 行号栏紫圆点；**白名单只认这两个键**，`@name`（正体紫）与 `@baseUrl`（文件变量）都不动。大文件纯文本分支补 `ids: {}`，行号签名纳入身份行位置。`verify-ui/check-s33.mjs` 24 项 |
| S3.2 字号缩放 | ✅ | `--pa-fs`/`--pa-lh` 挂在 `.pa-fe`，textarea / 高亮层 / 行号 / 折叠箭头 / ▶ 同源；`LINE_H` 常量换成 `lineH(fs)`；Ctrl+滚轮 12–28px、Ctrl+0 复位、`fontSize` 落偏好。**踩到真坑**：`app.css` 的 `.pa-root textarea{font-size:inherit}` 特异性 (0,1,1) 压过单类 `.pa-fe-text`，textarea 一直 12.5px、高亮层却变大 —— 规则改 `.pa-fe .pa-fe-text` 才压住。`verify-ui/check-s32.mjs` 25 项 |
| S3.1 浮层拖拽 | ✅ | 标题条拖动 → `--fe-dx/--fe-dy` 位移（不改 left/top，宽度不会被压变形），rAF 合帧 + `setPointerCapture`；整块夹在 `.work` 内，双击标题条归零；`feX/feY` 落偏好、启动恢复、缩放后重夹。顺带把 `.work` 的 `overflow:hidden` 改 `overflow:clip`（原来会变成可滚容器，scrollLeft 被顶偏 26px 导致浮层整体错位）。`verify-ui/check-s31.mjs` 20 项 |
| S2.6 示例自动挂载 | ✅ | 含 `POLARIS_MAP.save` 并发写修复（tmp 名唯一 + 串行） |
| S5.4 校验收口 | ✅ | `verify.mjs` 52 → **58** checks，新增 6 组 v1.0.0 断言（含「桥接访问器要真生效」这一条，用来钉住上面那个 bug） |
| S5.3 seed 退役 | ✅ | 删 `app.js` 的 `seed()`；`ensureDefaultSample` 顺带 noClobber 种 `http-client.env.json`（local/dev 只放 `envTag`），写完 `reloadEnvs()` 刷下拉 |
| S5.2 README / NOTICE | ✅ | 新增「调用历史」与「代价」两节；许可与署名 + NOTICE 写「自 1.0.0 起不再同步上游」及理由 |
| S5.1 示例 9 节 | ✅ | 头部与第 1 节讲身份注释；第 9 节用只写在 env 里的 `{{envTag}}` 演示「文件变量优先于 env」；示例不预置 id |
| S4.6 询问式接回 | ✅ | `retagInterfaceId` + `.identities.jsonl` 索引（宿主列不出 `_history/`）+ `findByIdentity / mergeInto / reuse`；顶部 `#idReuse` 只提示不动手，点了才接 |
| S4.5 历史面板 | ✅ | 响应区第 5 子页「历史」：10 条倒序、失败标红、页头写「最近 N 条 · X ms」；停在历史页时发送不顶走视图，历史写完再刷一次 |
| S4.4 发送链路收尾 | ✅ | `_results`（旧）与 `_history`（新）并存不双写；4xx/5xx 也记、网络异常与停止不记；**修 `dbx-bridge` 的 `hostAvailable()` 恒假** |
| S4.3 调用历史本体 | ✅ | `ui/http-history.js` 补四件事：① **轮转** —— `MAX_LINES = 10`（用户 2026-11-20 拍板），追加时超限就在同一次写里扔掉最旧的；同路径 read-modify-write 串成一条链（`serial`），连发不会互相踩（宿主共用 `<path>.tmp`）。② **读取** —— `parseJsonl` 坏行（截断 JSON / 不是对象）跳过并计 `bad`，一行坏不拖垮整份；文件不存在返回空数组。③ **二进制外置** —— `contentType` 命中 image/audio/video/font 或 `application/(octet-stream\|zip\|gzip\|pdf\|rar…)` 时，body 落 `_history/<collection>/<id>-<at>.bin`，jsonl 只留 `bodyRef` / `bodyEncoding` / `bodyBytes`；**宿主只有文本写**，所以 `.bin` 里是 base64（靠 `bodyEncoding` 标明），重名往后找序号不覆盖；上限是 `maxBodyBytes` 旋钮（**默认不设限，等拍板**），超了记 `bodyOmitted: TOO_LARGE`。④ **`.gitignore`** —— 只补一行 `_history/`，已有就不动、末尾缺换行也接得上。`app.js` 的 `recordHistory` 把 `contentType/isBinary/isBase64/bodyBase64` 传下去（只有真 base64 才外置）。`tools/history.test.mjs` 20 项 + `verify-ui/check-s43.mjs` 30 项 |
| S4.2 赋予时机 | ✅ | 新增 `ui/http-history.js` 的 `record()`：原文上插身份 → `writeText(baseMtime)` 成功 → 才追加 `_history/<collection>/<interfaceId>.jsonl`。写身份失败（READONLY / 冲突重试 2 次 / NO_SEGMENT）一律不写历史。`send()` 里 `recordHistory()` 异步旁路调用，成功后回填 `docRef.interfaceId/fileId` 并对齐 `baseMtime`。**定位顺序**：先在原文本定位段、再插 file_id（反了行号就漂）。顺带修 `patchGroup` 丢 `fileVars` 的老 bug。`tools/history.test.mjs` 9 项 + `verify-ui/check-s42.mjs` 23 项 |
| S4.1 身份纯函数 | ✅ | 新增 `ui/http-identity.js`（`POLARIS_IDENTITY`）：`newId` 8 位 base36（`crypto` 优先、可注入 rnd）；`insertFileId` 落在第一个 `###` 之前并与 `###` 隔一个空行，空文件即第 1 行；`insertInterfaceId` 落在该段 `###` 紧下一行（`line` / `index` 两种定位）；`dedupe` 同文件重复 id 后一个换新；`fingerprint` = 方法大写 + URL 归一（scheme/host 小写、默认端口/重复斜杠/末尾斜杠/fragment 抹掉，**query 保持原序**、`{{var}}` 不展开）。**只在原文上做行级拼接、不重序列化**，插入行沿用文件自己的行尾（CRLF 不掺裸 LF）。`tools/identity.test.mjs` 9 项 |

测试现状（改完必须保持）：
- `node tools/all.mjs` → **14 文件全绿**（`verify.mjs` **63** 项、`map.test.mjs` 22、`store.test.mjs` 31、`identity.test.mjs` 13、`history.test.mjs` **29**、`sample.test.mjs` 46、`cancel.test.mjs` **14** 等）
- `verify-ui/` **二十一个**端到端：s15=17、s22=29、s23=20、s24=10、s25=21、s25c=21、s25d=23、s26=8、s31=20、s32=25、s33=24、s42=23、s43=30、s44=13、s45=16、s46=18、s53=15、**s61=22**、**s71=12**、**s72=25**、**s62=10**
- Rust 侧（沙箱里现在能跑）：`cargo check` / `clippy` **零警告**；`node tools/live-cancel.mjs` **11 项全过**；
  `DS_KEY=... node tools/live-sse-stream.mjs` **7 项全过**（真 sidecar + 真 DeepSeek，验订阅式流）

---

## 4. 下一步：M7「发版」（S7.2–S7.4；S7.0/S7.1 已完成）

> 进 M7 前先把 `docs/plan-v1.0.0.md` 里 S7.0–S7.4 逐条读一遍，那里写死了发版要同步的五个版本位。

- **S7.0 ✅ 已完成**：0.6.4 的 PR #557 已撤回，分支留作参考，不发版本。
- **S7.1 ✅ 已完成（2026-11-21）**：格式冻结成 v1，落在 `docs/data-format.md`（**不是** README 一节，
  独立文档便于以后升版只改一处）。jsonl 每行首字段 `v`、`_history/_meta.json`、`FUTURE_FORMAT` 只读守卫、
  合并时用行原文保留未知字段。夹具在 `tools/fixtures/history-v1/`，`history.test.mjs` 29 项、
  `check-s71.mjs` 12 项钉住这些承诺。
- **S7.2 版本位（**暂缓，等 0.9.0 自用验收**）**：`manifest.json`、`backend/Cargo.toml`、`backend/Cargo.lock`、
  `.dbx-store.json` 的 `releaseNotes`、README 版本历史、`tools/verify.mjs` 的 `const VERSION` —— 六处一起改。
  改完 `grep -rn "0\.9\.0" --include=*.json --include=*.mjs --include=*.toml .` 应只剩历史叙述。
  > 现在四个版本位（manifest / Cargo.toml / Cargo.lock / verify）已经由 `tools/verify.mjs` 钉住一致；
  > `.dbx-store.json` 的 `releaseNotes` 仍是 0.6.4 文案 —— 它只影响商店展示，0.9.0 不上架，**留到 1.0.0 再写，避免写两遍**。
- **S7.3 出包（要通网）**：tag `v1.0.0` → GitHub Release → Actions 三平台构建（本仓库这份沙箱连不上 GitHub，
  只能在通网机器上做）。
- **S7.4 上架（要通网 + 维护者审）**：新开商店 PR，`candidates/com.zsky1.apifox.json` 指向 v1.0.0
  五平台产物 + `publishers/zsky1.json`，附 release notes。

发版前最后跑一次（沙箱里就能做的）：
```bash
cd backend && cargo clippy --all-targets -- -D warnings \
  --config 'patch.crates-io.dbx-plugin-sdk.path="vendor/dbx-plugin-sdk"'   # 零警告
cd .. && node tools/all.mjs && node tools/live-cancel.mjs
cd ../verify-ui && node check-s61.mjs && node check-s71.mjs
```

> **编 Rust**：`dbx-plugin-sdk` 没发布到 crates.io，仓库里带了一份副本
> （`backend/vendor/dbx-plugin-sdk/`，Apache-2.0，来源见该目录 README），裸构建时 patch 指向它：
> ```bash
> cd backend && cargo build --release --locked \
>   --config 'patch.crates-io.dbx-plugin-sdk.path="vendor/dbx-plugin-sdk"'
> ```
> **Cargo.toml 里必须保持 `{ version = "0.1.0" }`，不能改成 path 依赖。**
> 官方 `dbx-plugin package` 打包时会自带 SDK 并注入同一条 patch、再加 `--locked`；
> 写成 path 依赖会让那条 patch 变成「未使用」，cargo 要重写 lock，`--locked` 直接拒绝
> —— v0.9.0 发布首跑五平台全红就是这么挂的。
> 若 crates.io 慢，在 `~/.cargo/config.toml` 里把源换成 USTC 镜像（sparse）。

---

## 5. 待用户拍板（**别自己决定，问**）

### 5.1 浮层「⤢ 铺满」→ **已办，但不是加按钮**（2026-11-21，S3.4）

用户原话：「做成让它可以拖拉拽放大……下面的 bottom 可以被用户直接用鼠标拖拉往下拉」。
所以没做「⤢ 铺满」按钮（按钮只能给两种固定档），改成**连续可拖的下边界**：

- `.pa-fe` 最后一个 flex 子项是 9 px 的把手（`.pa-fe-grip`），按住往下拖 → 浮层变高、吃掉响应区，最多到工作区底；
- `layoutLayer()` 算的仍是**基准下边界** `feBaseBottom`，真正生效 `feBaseBottom - S.feGrow`；上限 `base - max(0, feY)`（标题条拖过之后能吃的量要变少，否则拉到底会有一截被裁）；
- 双击把手复位；`feGrow` 落偏好；左右分栏本来到底 → 把手 `display:none`；
- 验收：`verify-ui/check-s72.mjs` 25 项 + `verify.mjs` 一组契约。

**仍未变的一条硬限制**：插件跑在宿主 iframe 里，`position:fixed` 也只认 iframe 视口 ——
「铺满」最多铺满**插件面板**，铺不到整个 DBX 窗口。现在的拖拽最多铺满 `.work`，够用且不用碰宿主。

### 5.2 `.bin` 单文件 5 MB 上限

**现状**：`maxBodyBytes` 默认 `Infinity`，`app.js` 建 history 时没传，等于不设限。

**真正的硬顶在宿主**：SDK 的 `MAX_JSON_BYTES = 8 MiB`（单条 JSON-RPC 消息）。二进制响应以 base64 走
`http/request` 的返回值，本身就是 `4/3 × 原始字节`，**原始体约 6 MB 就会顶到 8 MiB**，超了不是「存不下历史」，
而是**整个响应都回不来**（报错或截断）。所以 5 MB 不是拍脑袋：它给 JSON 外壳留了约 1 MB 余量。

**选项**：A 维持不设限（大响应有整条链路失败的风险）；B 设 5 MB（超过只丢 `.bin`，历史行照记
`bodyOmitted: TOO_LARGE`，响应体当次仍能看）；C 设 4 MB（更保守，给 SSE/头留更多余量）。

**建议**：B。并且**顺手在 `http/request` 返回前就判断**：若 base64 长度接近 8 MiB，先把响应标 `truncated`，
别让 JSON-RPC 层直接炸（这条要改 Rust，属于 1.0.0 之后的小修）。

### 5.3 「停止」文案 → **已定 C（2026-11-21）**

**用户拍板：C，最简单的方式。** 现在界面上只有：

```
⏹ 已停止
耗时 1.2 s · https://…
```

状态栏「请求已停止 · 1.2 s」。原来的「已通知后端断开 / 正在传输的响应不会再读下去 / 仅逻辑中断」
整段删掉——那是实现口径，而且对端完全不发数据时后端会多挂一会儿，属轻微过度承诺。
耗时与 URL 保留（事实，不是解释）；历史页那条记录照旧不写（没响应）。
`verify-ui/check-s61.mjs` 已改成「必须出现『已停止』、必须不出现那三句」。

> 其余已定：历史保留 **10 条**（2026-11-20）；后端编译验证**已办**（见 §0）。

---

## 6. 发版口径（v0.6.x 之后换新序列）

- 版本号：`0.9.0` 当前值，**1.0.0 留待 UX 验收后再定**。之后每次发版 patch 递增（`v1.0.1`、`v1.0.2`…）。
- 发版要同步的版本位：`manifest.json`、`backend/Cargo.toml`、`backend/Cargo.lock`（`dbx-plugin-apifox-polaris-api`）、
  `.dbx-store.json` 的 `releaseNotes`、README 版本历史、`tools/verify.mjs` 的 `const VERSION`。
- 派生自上游 `misxzaiz/polaris-api` **v0.2.0**，**承诺不再同步上游任何代码**；1.0.0 要把这句写进 README「许可与署名」与包内 `NOTICE`。
- `v0.6.4` 的商店 PR #557 **已决定撤回**，等 1.0.0 数据格式冻结后一次性上架。

---

## 7. 跨平台迁移会踩的坑（已经踩过）

| 坑 | 处理 |
|---|---|
| `verify-ui/check-*.mjs` 里 `const CHROME = 'C:/Program Files/...'` 是 Windows 硬编码 | Mac 改成 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| `verify-ui/node_modules`（playwright-core）是 Windows 装的 | **没打进包里**，Mac 上 `cd verify-ui && npm i playwright-core` |
| 仓库内全是 LF（`i/lf w/lf`），本机 `core.autocrlf=true` | Mac 上设 `git config core.autocrlf input`，否则可能整树显示 modified |
| `tools/fixtures/messy.http` 必须是 CRLF（436 字节），但 blob 里存的是 LF | 已加 `.gitattributes` 指定 `text eol=crlf`；缺了它 Linux/Mac 上 `fixtures` / `store` 两个测试会红 |
| `check-s15/s22/s23.mjs` 里 `ROOT` 曾硬编码成 Windows 工作区绝对路径 | 已改成 `path.resolve(..., '..', 'apifox-polaris-api')`，与其余脚本一致；`CHROME` 也改为按平台解析（可用 `CHROME=` 覆盖） |
| 本机 `git push` 常 502 | 推送技巧在 `tools/push-one.mjs`（走 REST），token 用 `git credential fill` 取、用完删 |
| 无 `package.json`、无 npm 依赖 | 不需要 `npm install`；测试与 dev server 都是 `node xxx.mjs` 直跑 |

---

## 8. 怎么拿到代码（二选一）

**A. GitHub（首选，2026-11-20 已推送）**

```bash
git clone https://github.com/zsky1/apifox-polaris-api.git
cd apifox-polaris-api && git log --oneline -1   # 应能看到 a500446 及其后的 S2.5d 提交
```

代码、20 个提交的历史、本交接单全都在这。缺的只有 `verify-ui/` 和 `dev-workspace/`（见第 1 节）。

**B. 迁移包（离线备份 / 补 verify-ui 用）**

```
polaris-handoff-20261121-r15.zip   （7.6 MB，685 条目，已校验 UTF-8 文件名 + testzip）
├── apifox-polaris-api/     完整项目，含 .git（已解压实测过：git status 干净、14/14 全绿）
├── verify-ui/              端到端脚本 21 个（不含 node_modules，Mac 上 npm i playwright-core）
├── dev-workspace/          调试目录（含 wpa-workspace.json 与两个 .http）
└── .workbuddy/memory/      工作日志 + 长期约定（值得读 2026-11-21.md）
```

**关于对话历史**：`~/.workbuddy/projects/<cwd-hash>/*.jsonl`（24 MB）**不能跨机器 resume** ——
目录名是工作区路径算出来的 hash，换机器就挂不上新会话。想查原话的话，拷
`C:\Users\yanming\.workbuddy\projects\c-Users-yanming-WorkBuddy-2026-11-18-13-25-59\58f84e70-*.jsonl`
过去 grep 即可；正常接手读本文件就够。
