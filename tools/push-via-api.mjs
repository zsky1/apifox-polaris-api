/* tools/push-via-api.mjs — 当 git push 通道不可用时，用 GitHub Git Data API 推送当前分支。
 *
 * 用法：GITHUB_TOKEN=<fine-grained PAT> node tools/push-via-api.mjs
 *
 * 流程：本地 HEAD 的 tree -> 逐 blob 上传 -> 建 tree -> 建 commit（复刻本地
 * 的 message/author/committer，保证 SHA 与本地一致）-> force 更新远端 ref。
 * 每步都和本地 git 对象做 SHA 比对，任何一步不一致都会中止并报错。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = 'zsky1/apifox-polaris-api';
const BRANCH = 'main';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('missing GITHUB_TOKEN env'); process.exit(1); }

const API = `https://api.github.com/repos/${REPO}`;
const HDRS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'apifox-polaris-api-push',
  'Content-Type': 'application/json',
};

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'buffer', ...opts });
}
function gitText(args) { return git(args, { encoding: 'utf8' }); }

async function api(method, path, body, label) {
  let lastErr;
  for (let i = 1; i <= 5; i++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: HDRS,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (res.ok) return json;
      // 403/404 等业务错误不重试（4xx），5xx 重试
      if (res.status < 500) {
        throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      lastErr = new Error(`${label}: HTTP ${res.status} (attempt ${i})`);
    } catch (e) {
      if (String(e.message).startsWith(label + ': HTTP 4')) throw e;
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 3000 * i));
  }
  throw lastErr;
}

/* ---------- 1. 读取本地 HEAD 信息 ---------- */
const headSha = gitText(['rev-parse', 'HEAD']).trim();

function parseIdent(line) {
  // "author yanming <2410818122@qq.com> 1794987437 +0800"
  const m = line.match(/^(author|committer) (.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) throw new Error('无法解析 ident 行: ' + line);
  const ts = Number(m[4]);
  const off = m[5];
  const sign = off[0] === '-' ? -1 : 1;
  const hh = off.slice(1, 3), mm = off.slice(3, 5);
  // 本地墙钟时间 = UTC + 偏移
  const shifted = new Date(ts * 1000 + sign * (Number(hh) * 60 + Number(mm)) * 60000);
  const pad = n => String(n).padStart(2, '0');
  const isoWithOff = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign > 0 ? '+' : '-'}${hh}:${mm}`;
  return { name: m[2], email: m[3], date: isoWithOff };
}

/* 每个提交按 git cat-file 原样解析，保证远端重建的 SHA 与本地完全一致 */
function readCommit(sha) {
  const raw = git(['cat-file', 'commit', sha], { encoding: 'utf8' });
  const headerBlock = raw.slice(0, raw.indexOf('\n\n'));
  const message = raw.slice(raw.indexOf('\n\n') + 2);
  const parents = [...headerBlock.matchAll(/^parent ([0-9a-f]{40})$/gm)].map(m => m[1]);
  const tree = headerBlock.match(/^tree ([0-9a-f]{40})$/m)[1];
  return {
    sha, tree, parents, message,
    author: parseIdent(headerBlock.split('\n').find(l => l.startsWith('author '))),
    committer: parseIdent(headerBlock.split('\n').find(l => l.startsWith('committer '))),
  };
}

/* ---------- 2. 沿提交链逐个推送（root → HEAD） ---------- */
const chain = gitText(['rev-list', '--reverse', 'HEAD']).trim().split('\n').map(readCommit);
console.log(`本地 HEAD: ${headSha}，待推送提交 ${chain.length} 个`);

for (const c of chain) {
  console.log(`\n— commit ${c.sha.slice(0, 10)} ${c.message.split('\n')[0]}`);

  /* 2a. blob（按需上传，重复 blob 直接跳过） */
  const entries = gitText(['ls-tree', '-r', c.sha]).trim().split('\n').map(line => {
    const m = line.match(/^(\d{6}) (blob) ([0-9a-f]{40})\t(.+)$/);
    if (!m) throw new Error('ls-tree 解析失败: ' + line);
    return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
  });
  for (const e of entries) {
    const b64 = git(['cat-file', 'blob', e.sha]).toString('base64');
    const r = await api('POST', '/git/blobs', { content: b64, encoding: 'base64' }, `blob ${e.path}`);
    if (r.sha !== e.sha) throw new Error(`blob SHA 不一致 ${e.path}: 本地 ${e.sha} / 远端 ${r.sha}`);
  }
  console.log(`  blobs ok  ${entries.length} 个`);

  /* 2b. tree */
  const treeRes = await api('POST', '/git/trees', {
    tree: entries.map(e => ({ path: e.path, mode: e.mode, type: 'blob', sha: e.sha })),
  }, 'create tree');
  if (treeRes.sha !== c.tree) throw new Error(`tree SHA 不一致: 本地 ${c.tree} / 远端 ${treeRes.sha}`);
  console.log(`  tree ok  ${treeRes.sha.slice(0, 10)}`);

  /* 2c. commit */
  const commitRes = await api('POST', '/git/commits', {
    message: c.message,
    tree: c.tree,
    parents: c.parents,
    author: { name: c.author.name, email: c.author.email, date: c.author.date },
    committer: { name: c.committer.name, email: c.committer.email, date: c.committer.date },
  }, 'create commit');
  if (commitRes.sha !== c.sha) {
    throw new Error(`commit SHA 不一致: 本地 ${c.sha} / 远端 ${commitRes.sha}（远端 ref 不更新）`);
  }
  console.log(`  commit ok  ${commitRes.sha.slice(0, 10)}`);
}

/* ---------- 3. 更新远端 ref 到本地 HEAD ---------- */
await api('PATCH', `/git/refs/heads/${BRANCH}`, { sha: headSha, force: true }, 'update ref');
console.log(`\n✅ 推送完成：refs/heads/${BRANCH} -> ${headSha}`);
console.log(`https://github.com/${REPO}/commit/${headSha}`);
