/* 商店元数据与版本号一致性检查：node tools/store-meta.mjs [--tag vX.Y.Z]... [--all]
 *
 * 为什么要有这道检查：插件商城拿一个版本，有两条路——
 *   ① 候选 JSON（candidates/<id>.json，随 PR 提交，字段是手写的）；
 *   ② 自动同步（automation/plugin-sources.json 登记后，去读 tag 上的 .dbx-store.json）。
 * 两条路喂给商城的是同一套文案，所以「版本号」和「文案里自称的版本」必须对得上。
 * 一旦打 tag 在前、改文案在后，tag 上就冻结着上一版的 releaseNotes，
 * 商城会出现「版本 1.0.0 / 更新说明写着 0.6.4」这种自相矛盾的条目。
 *
 * 默认校验 HEAD；--tag 校验指定 tag 的快照；--all 校验本地全部 v* tag。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitShow(ref, file) {
  const r = spawnSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
function readAt(ref, file) {
  const raw = ref === 'HEAD' ? (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : null) : gitShow(ref, file);
  if (raw == null) throw new Error(`${ref}:${file} 不存在`);
  return raw;
}
function existsAt(ref, file) {
  if (ref === 'HEAD') return fs.existsSync(path.join(root, file));
  return gitShow(ref, file) != null;
}

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64'];

/** 校验某个 ref（HEAD 或 tag）上的元数据，返回问题列表；空数组 = 通过 */
export function checkRef(ref, expectedVersion) {
  const problems = [];
  const meta = JSON.parse(readAt(ref, '.dbx-store.json'));

  // 1) releaseNotes 首行必须自称当前版本：商城详情页的第一行就是这句
  const firstLine = String(meta.releaseNotes || '').split('\n')[0].trim();
  const claimed = (firstLine.match(/^(\d+\.\d+\.\d+)/) || [])[1];
  if (!claimed) problems.push(`releaseNotes 首行没有版本号：${JSON.stringify(firstLine.slice(0, 60))}`);
  else if (claimed !== expectedVersion) problems.push(`releaseNotes 首行自称 ${claimed}，实际版本 ${expectedVersion}`);

  // 2) 清单字段齐全且指向真实资源
  for (const k of ['name', 'description', 'icon', 'source', 'license']) {
    if (!meta[k]) problems.push(`缺少字段 ${k}`);
  }
  if (meta.icon && !existsAt(ref, meta.icon)) problems.push(`icon 指向的文件不存在：${meta.icon}`);
  const zh = (meta.localizations || {})['zh-CN'] || {};
  if (!zh.name || !zh.description) problems.push('缺少 zh-CN 本地化名称/描述');

  // 3) 候选 JSON 与版本、与 tag 上的下载地址必须一致
  const candPath = `store-pr/candidates/${'com.fax.apifox'}.json`;
  if (existsAt(ref, candPath)) {
    const cand = JSON.parse(readAt(ref, candPath));
    if (cand.version !== expectedVersion) problems.push(`候选 JSON 版本 ${cand.version} != ${expectedVersion}`);
    const targets = Array.isArray(cand.targets) ? cand.targets : [];
    for (const t of targets) {
      if (!String(t.url || '').includes(`/v${expectedVersion}/`)) problems.push(`target ${t.target} 的下载地址不指向 v${expectedVersion}`);
      if (!/^[0-9a-f]{64}$/.test(String(t.sha256 || ''))) problems.push(`target ${t.target} 的 sha256 不合法`);
    }
    const missing = PLATFORMS.filter(p => !targets.some(t => t.target === p));
    if (missing.length) problems.push(`候选 JSON 缺少平台：${missing.join(', ')}`);
    if (cand.name !== meta.name) problems.push('候选 JSON 名称与 .dbx-store.json 不一致');
  }
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const refs = [];
  if (argv.includes('--all')) {
    const r = spawnSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8' });
    refs.push(...String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean));
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tag') refs.push(argv[++i]);
  }

  const headVersion = JSON.parse(readAt('HEAD', 'manifest.json')).version;
  const jobs = refs.length ? refs.map(tag => ({ ref: tag, tag, version: tag.replace(/^v/, '') })) : [{ ref: 'HEAD', tag: null, version: headVersion }];

  let bad = 0;
  for (const job of jobs) {
    let problems;
    try {
      if (job.tag && spawnSync('git', ['rev-parse', '--verify', '--quiet', job.ref + '^{commit}'], { cwd: root }).status !== 0) {
        throw new Error('本地没有这个 tag（先 git fetch --tags origin）');
      }
      problems = checkRef(job.ref, job.version);
    } catch (e) {
      problems = [e.message];
    }
    if (problems.length) {
      bad++;
      console.log(`  ✗ ${job.tag || 'HEAD（' + job.version + '）'}`);
      problems.forEach(p => console.log('      - ' + p));
    } else {
      console.log(`  ok ${job.tag || 'HEAD'}（${job.version}）`);
    }
  }
  if (bad) {
    console.log(`\n${bad} 个版本的自述文案与版本号对不上——商城会出现「版本 x，更新说明写着 y」的条目。`);
    process.exit(1);
  }
  console.log(`\n${jobs.length} 个版本一致`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
