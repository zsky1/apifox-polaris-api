/* apifox.js 前端归一化自测。运行：node tools/apifox-front.test.mjs
 * 重点覆盖 Apifox 内部 API 把 parameters 返回成对象而非数组的情况。 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
global.window = global.window || {};
global.document = { getElementById: () => null };
global.DBXBridge = null;
global.POLARIS_CORE = {};
const A = require('../ui/apifox.js');

let pass = 0;
function ok(name, fn) { fn(); pass++; console.log('  ok  ' + name); }

ok('asArray 兼容数组 / 分组对象 / 名称映射 / JSON 字符串', () => {
  assert.deepEqual(A._test.asArray([1, 2]), [1, 2]);
  const grouped = A._test.asArray({
    header: [{ name: 'X-A', value: '1' }],
    query: [{ name: 'q', value: '2' }]
  });
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0]._group, 'header');
  assert.equal(grouped[1]._group, 'query');
  assert.deepEqual(A._test.asArray({ 'X-B': '2' }), [{ name: 'X-B', value: '2' }]);
  assert.equal(A._test.asArray('[{"name":"X-C","value":"3"}]').length, 1);
  assert.deepEqual(A._test.asArray(null), []);
});

ok('defHeaders 不再因 parameters 非数组报错，并过滤非 header 参数', () => {
  const h = A._test.defHeaders({
    headers: { 'Content-Type': 'application/json' },
    parameters: {
      header: [{ name: 'X-Token', value: 't', in: 'header' }],
      query: [{ name: 'q', value: '1', in: 'query' }]
    }
  });
  assert.deepEqual(h, ['Content-Type: application/json', 'X-Token: t']);
});

ok('defHeaders 兼容未标注 in 的 X- 头映射', () => {
  assert.deepEqual(A._test.defHeaders({ parameters: { 'X-Trace': 'abc', page: '1' } }), ['X-Trace: abc']);
});

ok('walkTree 兼容 children 非数组', () => {
  const out = [];
  A._test.walkTree({
    type: 'folder',
    name: 'F',
    children: { 0: { type: 'api', name: 'A', method: 'GET', path: '/a' } }
  }, '', out);
  assert.equal(out.length, 1);
  assert.equal(out[0].folderPath, 'F');
});

ok('只读插件：不暴露任何回写钩子与推送入口', () => {
  for (const key of ['push', 'onApiWritten', 'onEnvsWritten', 'onSourceSaved']) {
    assert.equal(A[key], undefined, '不应导出 ' + key);
  }
});

ok('只读插件：不提供任何写入辅助函数', () => {
  for (const key of ['findRec', 'folderForFile', 'folderIdForPath', 'reuseIid']) {
    assert.equal(A._test[key], undefined, '_test 不应暴露 ' + key);
  }
});

console.log(pass + ' 项通过');
