/* 一条命令跑全部自测：node tools/all.mjs
 * 只串行跑、如实透传退出码——任何一项红就整体红，方便发版前一把过。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'tools/verify.mjs',
  'tools/store-meta.mjs',
  'tools/http-file.test.mjs',
  'tools/identity.test.mjs',
  'tools/history.test.mjs',
  'tools/fixtures.test.mjs',
  'tools/serialize.test.mjs',
  'tools/store.test.mjs',
  'tools/map.test.mjs',
  'tools/fs-contract.test.mjs',
  'tools/migrate.test.mjs',
  'tools/project.test.mjs',
  'tools/vars.test.mjs',
  'tools/multipart.test.mjs',
  'tools/sample.test.mjs',
  'tools/cancel.test.mjs',
  'tools/apifox-front.test.mjs',
];

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(root, f)], { stdio: 'inherit' });
  if (r.status !== 0) { failed++; console.log('\n[FAIL] ' + f); }
}
console.log('\n' + (files.length - failed) + '/' + files.length + ' 个测试文件通过');
process.exit(failed ? 1 : 0);
