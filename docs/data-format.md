# 数据格式（1.0.0 冻结）

> 这份文档是**契约**，不是说明稿。1.0.0 发布之后，下面每一个字段的名字、类型、语义都只能**新增**，不能改名、不能改语义、不能删。
> 改这些的唯一合法方式是**升 `v`**，并让旧版本把新数据当只读。
>
> 冻结时间：2026-11-21（1.0.0 上架前）。冻结范围只覆盖本插件的文件格式，不覆盖 UI、DOM、内部函数名。

---

## 0. 四类落盘载体

| 载体 | 路径 | 谁写 | 谁读 |
|---|---|---|---|
| 请求文件 | 用户自己的 `*.http` / `*.rest` | 插件只在其中加两行注释 | 插件、IDEA、VS Code |
| 环境文件 | 资源目录下 `http-client.env.json` | 用户（插件首次打开时种一份） | 插件（只读） |
| 调用历史 | `<资源目录>/_history/` | 插件 | 插件 |
| 忽略规则 | `<资源目录>/.gitignore` | 插件补一行 | git |

`<资源目录>` 就是 `wpa-workspace.json` 里记的目录，**唯一来源**，插件不扫盘找它。

```
<资源目录>/
├── wpa-workspace.json
├── http-client.env.json
├── .gitignore                 ← 含一行 `_history/`
├── demo.http
└── _history/
    ├── _meta.json             ← 整份历史的格式版本（见 §3）
    └── demo/                  ← collection：文件名去掉 .http/.rest
        ├── .identities.jsonl  ← 指纹索引（内部用，可重建，不冻结）
        ├── login001.jsonl     ← 一个接口一份，最近 10 条
        ├── login001-1732060920000.bin
        └── __missing__/       ← 接口 id 找不到时归到这里（见 §2.4）
```

---

## 1. `.http` 文件里的两行身份注释

插件会往用户文件里写**两行普通注释**，都放在 `#` 注释语法内，IDEA / VS Code 一律当注释忽略：

| 位置 | 形态 | 含义 |
|---|---|---|
| 文件级：**第一个 `###` 之前**（空文件 = 第 1 行） | `# @file_id <8 位 base36>` | 这个文件的身份，跨重命名保留 |
| 段落级：该段 `###` 的**紧下一行** | `# @interface_id <8 位 base36>` | 这个接口的身份，历史按它归档 |

示例：

```http
# @file_id k3m9x2ab

### 登录
# @interface_id login001
POST {{baseUrl}}/login
Content-Type: application/json

{"user":"admin"}
```

**兼容承诺**

- 之后新增的任何元信息**也只能是 `# @key value` 这一种形态**，不会出现 `//`、`/* */` 或其它语言的注释符。
- 两个已有 key 的语义永不变：`@file_id` 永远指文件、`@interface_id` 永远指接口。
- 删掉它们不会损坏文件，只会断掉历史归属；插件检测到同一指纹下还有旧 id 时会**问一句**再决定是否接回。
- 这两个 key 不参与变量插值，也不会出现在请求里。

---

## 2. `_history/<collection>/<interfaceId>.jsonl`

一行一条调用记录，UTF-8，行尾跟随该文件首次创建时的风格（CRLF 文件不掺裸 LF）。一个接口最多 **10** 行，超出时在同一次写里裁掉最旧的。

### 2.1 字段表（`v = 1`）

| 字段 | 类型 | 必填 | 语义 | 兼容规则 |
|---|---|---|---|---|
| `v` | number | **是** | 行格式版本。1.0.0 写的都是 `1` | **必须是首字段**；只会增大，永不减小 |
| `at` | number | 是 | 发出时间，Unix 毫秒 | 永不变 |
| `status` | number | 是 | HTTP 状态码；没拿到响应时为 `0` | 永不变 |
| `ok` | boolean | 是 | `status` 在 200–399 之间 | 永不变 |
| `timeMs` | number | 是 | 总耗时（毫秒） | 永不变 |
| `size` | number | 是 | 响应体字节数 | 永不变 |
| `method` | string | 是 | 实际方法，**大写** | 永不变 |
| `url` | string | 是 | 变量已展开的实际 URL | 永不变 |
| `urlTemplate` | string | 是 | 未展开的原始模板（可能含 `{{var}}`） | 永不变 |
| `fingerprint` | string | 是 | `METHOD + 空格 + 规范化模板`：方法大写、变量不展开、query 保序 | **语义永不变**，接回旧 id 靠它 |
| `contentType` | string | 是 | 响应 `Content-Type` 原值；没有则空串 | 永不变 |
| `interfaceId` | string \| null | 是 | 该接口 id；理论上不为 null（写历史前已确保身份落盘） | 永不变 |
| `fileId` | string \| null | 是 | 该文件 id | 永不变 |
| `file` | string | 是 | 文件名，**不含路径** | 永不变 |
| `name` | string | 是 | `# @name` 的值；没有则空串 | 永不变 |
| `bodyRef` | string | 否 | 响应体外置文件名，相对同目录：`<interfaceId>-<at>[-n].bin` | 缺失 = 响应体未保存 |
| `bodyEncoding` | string | 否 | 有 `bodyRef` 时必填，目前恒 `"base64"` | 新增编码只能新增枚举值 |
| `bodyBytes` | number | 否 | 解码后的真实字节数 | 永不变 |
| `bodyOmitted` | string | 否 | 为什么没存体：`TOO_LARGE` / `WRITE_FAILED` / `NAME_EXHAUSTED` / `NO_BODY` | 只能新增枚举值 |

> 设计稿 13.4 里的 `ts`/`res.*`/`durationMs` 是早期设想，**以实现为准**：实际字段是上表这一组，`at` 用毫秒数而不是 ISO 字符串（排序、比较都不需要再解析）。

### 2.2 一行真实数据

```json
{"v":1,"at":1732060800000,"status":200,"ok":true,"timeMs":42,"size":128,"method":"POST","url":"https://api.example.com/login","urlTemplate":"{{baseUrl}}/login","fingerprint":"POST {{baseUrl}}/login","contentType":"application/json","interfaceId":"login001","fileId":"demo0001","file":"demo.http","name":"登录"}
```

带外置响应体的一行：

```json
{"v":1,"at":1732060920000,"status":200,"ok":true,"timeMs":210,"size":20480,"method":"GET","url":"https://api.example.com/avatar","urlTemplate":"{{baseUrl}}/avatar","fingerprint":"GET {{baseUrl}}/avatar","contentType":"image/png","interfaceId":"avat0001","fileId":"demo0001","file":"demo.http","name":"头像","bodyRef":"avat0001-1732060920000.bin","bodyEncoding":"base64","bodyBytes":20480}
```

### 2.3 兼容规则（读写双方都要守）

1. **只加字段、不改语义、不删字段。** 1.x 里出现的字段，之后任何一个 1.x 版本都必须还能按同一语义解释。
2. **读到未知字段：原样保留。** 插件只在「接回合并」时需要重写整个文件，此时用的是行原文（`__raw`），不做 `JSON.parse → stringify` 的往返，所以未知字段、键序、数字写法都不会被洗掉。轮转只整行裁剪，也不碰行内内容。
3. **读到 `v` 大于自身（比如 1.0.0 读到 `v:2`）：只读展示 + 提示升级。** 历史面板照常列出这些行，但不再往这份 jsonl 追加新记录（返回 `FUTURE_FORMAT`），避免把新版本的数据混进旧解释器。
4. **读到没有 `v` 的行（0.9.x 写的）：按 `v1` 解释。** 不迁移、不改写、不补字段。
5. **坏行（截断 JSON / 不是对象）跳过并计数**，一行坏不能拖垮整份历史。

### 2.4 已知边界

- 接口 id 缺失时，文件名退化为 `unknown.jsonl`；不会新建 `__missing__` 目录（早期设计稿里的路径，未实现，也不打算实现）。
- 文本响应**不存正文**，只存 `size`。历史面板展示的是元信息，不是响应体。
- 二进制响应外置成 `.bin`（见 §4），jsonl 里只留引用，单行不会被撑爆。

---

## 3. `_history/_meta.json`

```json
{"formatVersion":1,"app":"com.zsky1.apifox","createdAt":"2026-11-21T01:40:00.000Z"}
```

| 字段 | 类型 | 必填 | 语义 | 兼容规则 |
|---|---|---|---|---|
| `formatVersion` | number | 是 | 整份历史的格式版本，1.0.0 = `1` | 只增 |
| `app` | string | 是 | 固定 `com.zsky1.apifox`，防止误读别人的目录 | 永不变 |
| `createdAt` | string | 是 | 首次建立时的 ISO 8601 时间 | 永不变 |

**写入规则**

- 资源目录第一次记历史时创建，**之后永不覆盖**。
- 已存在且能读懂 → 一个字节都不动。
- 已存在但读不懂（手改坏了，或更新版本写的新结构）→ 不覆盖，只报告 `META_UNREADABLE`。覆盖等于把「该升级了」这个信号抹掉。
- 文件缺失时按 `formatVersion = 1` 处理（0.9.x 的目录没有它）。

---

## 4. `_history/<collection>/*.bin`

| 项 | 约定 |
|---|---|
| 内容 | 原始响应字节的 **base64 文本** |
| 文件名 | `<interfaceId>-<at>[-n].bin`，同毫秒重名时 `n` 从 2 递增（最多找 20 个） |
| 为什么是 base64 | 宿主只提供文本写（utf8），没有二进制写通道；硬写裸字节会被当 utf8 弄坏。后缀保留 `.bin` 是为了与计划对齐，读的时候先看 `bodyEncoding` |
| 引用 | jsonl 的 `bodyRef` + `bodyEncoding: "base64"` + `bodyBytes` |
| 兼容承诺 | 只增不删；缺失时降级为「响应体未保存」，不报错 |
| 上限 | **5 MB**（`maxBodyBytes`，2026-11-21 定）；超过则记 `bodyOmitted: "TOO_LARGE"` + 真实 `bodyBytes`，**不落 .bin**，历史行照记 |
| 为什么是 5 MB | 宿主单条 JSON 消息硬顶 **8 MiB**（SDK `MAX_JSON_BYTES`），二进制响应要 base64 装在 JSON 里（膨胀 4/3）——原始体约 **6 MiB 就会把整条消息顶穿**，那时不是历史存不下，而是这次响应压根回不来。5 MB 比硬顶低约 20%，给 headers 与 JSON 外壳留余量 |
| 想要更大的响应 | 不能靠调大这个数：那是协议硬顶，调了也不会生效。要做 20 MB 级得换通道（后端把 body 落盘、JSON 只回路径，UI 分块读），属于后续版本 |

---

## 5. `http-client.env.json`

沿用 IDEA 原生结构，**不扩展任何字段**：

```json
{
  "local": {"baseUrl": "http://127.0.0.1:8080", "envTag": "local"},
  "dev":   {"baseUrl": "https://dev.example.com", "envTag": "dev"}
}
```

- 只读兼容：插件读它来渲染环境下拉、做变量插值，**从不写回**。
- 文件里的 `@var` 优先级高于环境变量；同名时以文件为准。
- 首次打开资源目录时，若没有这个文件，插件种一份只含 `envTag` 的最小样例（已存在则不动）。

---

## 6. `.gitignore`

插件只做一件事：确保里面有 `_history/` 这一行。

- 文件不存在 → 新建，内容就是 `_history/\n`。
- 文件存在但没有这一行 → 追加一行（末尾没换行时先补一个）。
- 已有 `_history/` / `_history` / `/_history/` / `/_history` 任一种写法 → 不动。
- **不重排、不删用户的其它行。**

---

## 7. 不冻结、不承诺的东西

| 东西 | 原因 |
|---|---|
| `_history/<collection>/.identities.jsonl`（`{fp,id,at}`） | 内部索引，宿主列不出 `_history/` 目录才需要它；丢了只会少一次接回提示，不影响历史本身。格式随时可改 |
| storage 里的键（`dir`/`autoSave`/`activeEnv`/`lastPath`/…） | 纯 UI 偏好，坏了最多重置一次 |
| `wpa-workspace.json` | 目录指针，由工作区模块自己维护 |
| 0.6.x 的 `results/*.json` | 已淘汰的过渡格式，**不迁移**、不承诺读取 |
| UI 的 DOM 结构、函数名、内部模块边界 | 不是数据 |

---

## 8. 版本历史

| `v` | 版本 | 变化 |
|---|---|---|
| 1 | 1.0.0 | 初版：`v`/`at`/`status`/`ok`/`timeMs`/`size`/`method`/`url`/`urlTemplate`/`fingerprint`/`contentType`/`interfaceId`/`fileId`/`file`/`name`，可选 `bodyRef`/`bodyEncoding`/`bodyBytes`/`bodyOmitted` |

**升版流程（写给未来的自己）**

1. 新字段先加，`v` 不变 —— 只要旧版本能安全忽略它（比如再一个可选字段）。
2. 一旦旧版本的忽略会导致误读（改语义、删字段、改类型），才升 `v`。
3. 升 `v` 时同时改 `ui/http-history.js` 的 `FORMAT_VERSION`、本文件、`tools/fixtures/history-v1/` 里加一份 `v(N+1)-future.jsonl`。
4. 新版必须能读旧数据（向后兼容），旧版读到新数据只读展示（向前安全）。

---

## 9. 自测锚点

| 断言 | 位置 |
|---|---|
| 新记录首字段是 `v` 且等于 1 | `tools/history.test.mjs` |
| `_meta.json` 首次创建、二次不动、坏文件不覆盖 | 同上 |
| 读没有 `v` 的旧行不报错 | 同上（`tools/fixtures/history-v1/legacy-no-v.jsonl`） |
| 未知字段在合并后逐字节保留 | 同上（`unknown-field.jsonl`） |
| `v:2` 只读、不追加、提示升级 | 同上（`v2-future.jsonl`） |
| 文档里四类载体都有字段表 | `tools/verify.mjs` |

---

## 10. 附：SSE 事件协议（不落盘，但同样是契约）

订阅式流把 SSE 的每一块从 sidecar 推到 UI，走的是宿主的 `host.events` 通道，
**不写磁盘**。但它跨了三个进程（sidecar → 宿主 → iframe），字段名一改就断，
所以一并冻结在这里。

| 项 | 值 |
|---|---|
| 事件名 | `apifox/http/stream` |
| 通道 | 插件 stdout（JSON-RPC 通知）→ 宿主 `host.events` → iframe `postMessage({source:"dbx-host",version:1,type:"event",method,params})` |
| 权限 | `manifest.json` 必须声明 `host.events` |
| 顺序 | 同一请求内严格按 `seq` 递增；`seq` 只用于排查，UI 按到达顺序拼接 |

三条消息，靠 `phase` / `done` / `chunk` 区分：

| 消息 | 字段 | 语义 |
|---|---|---|
| 开流 | `requestId, phase:"open", status, statusText, ok, contentType, headers` | 宿主确实在转发才继续流式；发不出去就退回一次性返回 |
| 正文块 | `requestId, seq, chunk` | `chunk` 是一个完整 SSE 事件原文（含结尾空行）；单个事件过大时按 256 KiB 切开 |
| 收尾 | `requestId, done:true, seq, status, statusText, ok, contentType, headers, size, timeMs, cancelled, truncated, error` | `size` 是字节总数，不是块数 |

约束：

1. **单条事件仍是 JSON 消息**，所以单条上限还是 8 MiB —— 实现上按 256 KiB 切块，正常 SSE 一条只有几百字节到几 KB。
2. `chunk` 只保证「拼起来等于原始字节流」，不保证每块是合法 UTF-8；UI 只做文本拼接与显示。
3. 收到 `done` 才允许定稿（事件与 RPC 响应是两条路，响应可能先到）。
4. 改这里的字段名 = 改协议，`tools/verify.mjs` 与 `verify-ui/check-s62.mjs` 会红。
