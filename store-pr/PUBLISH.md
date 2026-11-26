# apifox-polaris-api 上架 DBX Store 操作手册

插件已改名并改造完成。商店身份：`com.zsky1.apifox` / `zsky1` / `1.1.0`（ID 前缀、发布者、GitHub 账号三者一致，避免身份审核歧义）。
源码仓库：`https://github.com/zsky1/apifox-polaris-api`（已创建为空仓库）。

**为什么你还需要手动操作几步**：DBX Store 要求作者在**自己的公开仓库**发布
未签名候选包，且审核签名由维护者完成。AI 侧没有你的 GitHub 推送凭据，本地
`git push` 也被环境安全策略拦截，所以推送/打 tag/提 PR 必须由你在本地或网页完成。

---

## 第 0 步：确认本地状态

```bash
cd C:/Users/654143/WorkBuddy/2026-11-25-16-15-18/apifox
git status                       # 应只剩新增的 store-pr/PUBLISH.md、PR_BODY.md、publishers/zsky1.json、tools/fill-candidate-from-release.mjs
git remote -v                    # origin 应指向 https://github.com/zsky1/apifox-polaris-api.git
node tools/all.mjs               # 17/17
node tools/verify.mjs            # 69 checks
node tools/store-meta.mjs        # HEAD 一致
```

## 第 1 步：提交新增的上架材料并推送

```bash
git add -A
git commit -m "chore(store): 准备 dbx-store 上架候选材料"
git push -u origin main
```

推送后刷新 https://github.com/zsky1/apifox-polaris-api 应能看到全部源码。

## 第 2 步：打 tag 触发官方 Release 构建

```bash
git tag -a v1.1.0 -m "v1.1.0 — apifox 只读拉取版"
git push origin v1.1.0
```

tag 推送后无需手动操作：仓库里的 `.github/workflows/plugin-release.yml` 会
校验 tag 上的商店元数据，然后调用 DBX 官方 reusable workflow，为 5 个平台
（darwin-arm64 / darwin-x64 / linux-arm64 / linux-x64 / windows-x64）构建
未签名 `.dbxp`，并生成 `release-candidates.json` + 每个包的 `.artifact.json`。

在 GitHub Actions 页面确认 workflow 跑绿（约几分钟）。

## 第 3 步：创建 GitHub Release

在 https://github.com/zsky1/apifox-polaris-api/releases/new 选 tag `v1.1.0`，
标题填 `v1.1.0`，Release Notes 可直接用 `README.md` 里 v1.1.0 那条，或写：

> apifox-polaris-api v1.1.0 — 只读拉取 Apifox 接口树与环境，本地改动不回写。

发布（published）后，第 2 步的 workflow 会再次触发并把构建产物上传到这个
Release。**确认 Release 里出现 5 个 `.dbxp` 和 `release-candidates.json`**。

## 第 4 步：回填候选 sha256 / size

下载该 Release 的 `release-candidates.json` 到仓库根目录，然后：

```bash
node tools/fill-candidate-from-release.mjs v1.1.0
node tools/store-meta.mjs
node tools/verify.mjs
```

这一步把 5 个平台的真实 sha256/size/URL 写进
`store-pr/candidates/com.zsky1.apifox.json`，并校验一致性。

```bash
git add store-pr/candidates/com.zsky1.apifox.json
git commit -m "chore(store): 回填 v1.1.0 候选包 sha256 与 size"
git push
```

## 第 5 步：向 dbx-store 提交 catalog PR

1. Fork https://github.com/t8y2/dbx-store 到你账号。
2. 在 fork 里新建分支 `submit/com.zsky1.apifox-1.1.0`。
3. 添加/修改三个文件：
   - `publishers/zsky1.json` —— 内容见本目录 `publishers/zsky1.json`：
     `{ "id": "zsky1", "name": "zsky1", "status": "unverified" }`
   - `candidates/com.zsky1.apifox.json` —— 复制本仓库第 4 步回填后的同名文件（**不要**放进 `plugins/`）。
   - `automation/plugin-sources.json` —— 把文件末尾原有的
     `{ "repository": "nianshengmei/warren-polaris-api", ... }` **替换**为你的仓库，
     便于后续版本自动开 PR：
     ```json
     { "repository": "zsky1/apifox-polaris-api", "metadataPath": ".dbx-store.json", "autoUpdate": true }
     ```
     注意：那条旧登记属于原作者的旧插件 ID（`com.warren.polaris.api`），与你的
     `com.zsky1.apifox` 不是同一个插件；不要共用同一条。若维护者要求不动它，就改为
     **新增**一条你的仓库登记，而不是替换。
4. PR 描述用本目录 `PR_BODY.md` 的全文。
5. 向 `t8y2/dbx-store:main` 开 PR。

## 第 6 步：审核与签名（维护者完成）

- CI 会保持红灯并显示 `open candidate(s) awaiting DBX Store signing`——这是**故意**的，防止未签名包被合并。
- 维护者人工审核后，在 PR 里评论 `/sign` 触发受保护签名工作流。
- 工作流会校验候选字节、用商店 Ed25519 私钥签名、上传到 R2，并把最终
  `plugins/com.zsky1.apifox.json`、`catalog/index.json` 和签名回执写回同一个 PR。
- CI 转绿、维护者合并后，商店目录更新，任何 DBX 用户都能从插件市场搜索安装。

---

## 一个必须知道的风险点

**首次上架审核周期不承诺 SLA**。README 明确"initial repository does not promise
an automatic approval SLA"。被拒的常见原因：权限过宽、许可不清、native 行为
可疑、源码到产物无法核对。本插件的权限只有 `host.storage` + `host.events`，
native sidecar 无监听端口、无子进程，已按最小权限准备。

身份问题已消除：插件 ID `com.zsky1.apifox` 的前缀、publisher `zsky1` 与
GitHub 账号 `zsky1` 完全一致，无需额外证明第三方身份。

## 相关文件

- `store-pr/PR_BODY.md` —— 商店 PR 描述
- `store-pr/publishers/zsky1.json` —— 首次上架的发布者记录
- `store-pr/candidates/com.zsky1.apifox.json` —— 候选清单（第 4 步回填后使用）
- `tools/fill-candidate-from-release.mjs` —— 从 Release 回填 sha/size
