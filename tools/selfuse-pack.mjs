/* 0.9.0 自用包：把「插件目录」摊出来，能装、能看、能核对版本。
 *
 * 用法（在仓库根）：
 *   cd backend && cargo build --release && cd ..
 *   node tools/selfuse-pack.mjs
 *   node tools/selfuse-pack.mjs --bin /abs/path/to/dbx-plugin-apifox
 *   node tools/selfuse-pack.mjs --no-zip
 *
 * 产物：
 *   dist/apifox-<version>-<os>-<arch>/         ← 插件目录（manifest + ui/ + bin/）
 *   dist/apifox-<version>-<os>-<arch>.zip      ← 同上，打包带走
 *
 * 它**不**生成 .dbxp —— 那要官方 CLI：`dbx-plugin package .`。
 * 脚本会把命令打出来；装了 CLI 就跑一下，没装也能直接拿目录跑 `dbx-plugin dev --path .`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = args.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return dflt;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  return args[args.indexOf(hit) + 1] || dflt;
};
const noZip = args.includes('--no-zip');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const exeName = manifest.entrypoints.backend.executable.split('/').pop();
const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const tag = `apifox-${version}-${osName}-${process.arch}`;
const dist = path.join(root, 'dist');
const stage = path.join(dist, tag);

const bin = path.resolve(argOf('--bin', path.join(root, 'backend', 'target', 'release', exeName)));
if (!fs.existsSync(bin)) {
  console.error('找不到二进制：' + bin);
  console.error('先在 backend/ 里编译：cargo build --release（需要 dbx-plugin-sdk，见 HANDOFF）');
  process.exit(2);
}
const binSize = fs.statSync(bin).size;
if (binSize < 512 * 1024) {
  console.error('二进制只有 ' + binSize + ' 字节，不像是 release 产物：' + bin);
  process.exit(2);
}

/* ---- 版本位一致性：别把 0.9.0 的 manifest 配 0.8.0 的二进制 ---- */
const cargoToml = fs.readFileSync(path.join(root, 'backend', 'Cargo.toml'), 'utf8');
const cargoVer = (cargoToml.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
const lock = fs.readFileSync(path.join(root, 'backend', 'Cargo.lock'), 'utf8');
const lockBlock = lock.split(/\n\[\[package\]\]\n/).find((b) => b.includes('name = "dbx-plugin-apifox"')) || '';
const lockVer = (lockBlock.match(/^version\s*=\s*"([^"]+)"/m) || [])[1];
if (cargoVer !== version || lockVer !== version) {
  console.error(`版本位不一致：manifest=${version} Cargo.toml=${cargoVer} Cargo.lock=${lockVer}`);
  process.exit(2);
}

/* ---- 摊目录 ---- */
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
for (const p of ['manifest.json', 'LICENSE', 'NOTICE', 'dbx-plugin.toml']) {
  fs.copyFileSync(path.join(root, p), path.join(stage, p));
}
for (const d of ['ui', 'assets']) {
  fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
}
fs.copyFileSync(bin, path.join(stage, 'bin', exeName));
fs.chmodSync(path.join(stage, 'bin', exeName), 0o755);

fs.writeFileSync(path.join(stage, 'INSTALL.txt'), [
  `apifox ${version} · 自用构建（${osName}-${process.arch}）`,
  '',
  '这个目录就是插件本体：manifest.json + ui/ + bin/。',
  `sidecar 二进制：bin/${exeName}（${(binSize / 1048576).toFixed(1)} MB，本机架构）`,
  '',
  '装法（二选一）：',
  '  1) 有官方 CLI：在本仓库根跑 `dbx-plugin package .`，产物在 dist/*.dbxp；',
  '     DBX → 插件中心 → 设置 → 第三方与开发者选项 → 允许安装未签名开发包，再选那个 .dbxp。',
  '  2) 没有 CLI：`dbx-plugin dev --path . --port 5190` 起开发态，或用 DBX 的本地插件目录指向本目录。',
  '',
  '装完按 docs/self-test-0.9.0.md 走一遍验收清单。',
  ''
].join('\n'));

/* ---- 打 zip ---- */
let zipPath = null;
if (!noZip) {
  zipPath = path.join(dist, tag + '.zip');
  fs.rmSync(zipPath, { force: true });
  try {
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path '${stage}' -DestinationPath '${zipPath}' -Force`], { stdio: 'inherit' });
    } else {
      execFileSync('zip', ['-qr', zipPath, tag], { cwd: dist, stdio: 'inherit' });
    }
  } catch (e) {
    console.warn('打 zip 失败（目录还在，可以直接用）：' + (e && e.message));
    zipPath = null;
  }
}

const files = [];
(function walk(d) {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p); else files.push(path.relative(stage, p));
  }
})(stage);

console.log('');
console.log(`版本 ${version} · ${osName}-${process.arch}`);
console.log(`目录 ${path.relative(root, stage)}  （${files.length} 个文件）`);
for (const f of files.sort()) console.log('  ' + f);
if (zipPath) {
  const zs = fs.statSync(zipPath).size;
  console.log(`\nzip  ${path.relative(root, zipPath)}  （${(zs / 1048576).toFixed(1)} MB）`);
}
console.log('\n要出 .dbxp（装进 DBX 用）：在本仓库根跑  dbx-plugin package .');
