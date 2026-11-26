/* 从插件仓库 Release 的 release-candidates.json 回填 dbx-store 候选清单的 sha256/size。
 *
 * 用法（在仓库根）：
 *   node tools/fill-candidate-from-release.mjs <release-tag> [candidate-file]
 * 例：
 *   node tools/fill-candidate-from-release.mjs v1.1.0
 *
 * 输入：本仓库 GitHub Release 上的 release-candidates.json（由官方 reusable
 * workflow 在 Release published 时生成），结构为
 *   { "candidates": [ { target, url, sha256, size, artifact ... }, ... ] }
 * 或顶层就是数组。脚本按 target 对齐，逐项回填候选 JSON 的 targets，
 * 并把 source / homepage 指向本仓库的 tag。
 *
 * 只改 sha256/size/url 与仓库地址，不改描述文案、版本、ID、发布者。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [tag, candidateArg] = process.argv.slice(2);
if (!tag) {
  console.error('用法：node tools/fill-candidate-from-release.mjs <release-tag> [candidate-file]');
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const candPath = path.resolve(root, candidateArg || `store-pr/candidates/${manifest.id}.json`);
const cand = JSON.parse(fs.readFileSync(candPath, 'utf8'));

const releaseFile = path.resolve(root, process.env.RELEASE_CANDIDATES || 'release-candidates.json');
if (!fs.existsSync(releaseFile)) {
  console.error(`找不到 ${releaseFile}。`);
  console.error('请先把 Release 上的 release-candidates.json 下载到仓库根，或用 RELEASE_CANDIDATES 指定路径。');
  process.exit(2);
}
const raw = JSON.parse(fs.readFileSync(releaseFile, 'utf8'));
const list = Array.isArray(raw) ? raw : (raw.candidates || raw.artifacts || raw.targets || []);
const byTarget = new Map(list.map((x) => [x.target, x]));
const releaseBase = `https://github.com/zsky1/apifox-polaris-api/releases/download/${tag}/`;

const required = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'];
const missing = [];
for (const t of required) {
  const item = byTarget.get(t);
  if (!item) { missing.push(t); continue; }
  const sha = String(item.sha256 || '');
  const size = Number(item.size || 0);
  const urlValue = String(item.url || '');
  const url = /^https:\/\//.test(urlValue) ? urlValue : `${releaseBase}${urlValue}`;
  if (!/^[0-9a-f]{64}$/.test(sha) || !(size > 0) || !/^https:\/\//.test(url)) {
    console.error(`target ${t} 的 sha256/size/url 不完整：`, { sha, size, url });
    process.exit(2);
  }
  const row = cand.targets.find((x) => x.target === t);
  if (row) {
    row.sha256 = sha;
    row.size = size;
    row.url = url;
  } else {
    cand.targets.push({ target: t, url, sha256: sha, size });
  }
}
if (missing.length) {
  console.error(`release-candidates.json 缺少平台：${missing.join(', ')}`);
  process.exit(2);
}

cand.version = version;
cand.source = `https://github.com/zsky1/apifox-polaris-api/tree/${tag}`;
cand.homepage = 'https://github.com/zsky1/apifox-polaris-api';
for (const t of cand.targets) t.url = t.url.replace(/\/v[^/]+\//, `/${tag}/`);

fs.writeFileSync(candPath, JSON.stringify(cand, null, 2) + '\n');
console.log(`已从 ${tag} 回填 ${cand.targets.length} 个平台到 ${path.relative(root, candPath)}:`);
for (const t of cand.targets) console.log(`  ${t.target}: ${t.sha256.slice(0, 12)}… ${t.size}`);
