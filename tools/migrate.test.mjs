/* 旧数据迁移自测。运行：node tools/migrate.test.mjs
 *
 * 判据：storage 里的 JSON 搬到磁盘后，「请求数 / 方法 / URL / 请求体」必须一字不差；
 * 再跑一次不产生新文件（幂等）；目标文件已存在时绝不覆盖，旧 JSON 留档。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fsHost } from './fs-host.mjs';
const require = createRequire(import.meta.url);
const S = require('../ui/http-store.js');
const H = require('../ui/http-file.js');

let pass = 0;
function ok(name, fn) { return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok  ' + name); }); }

const row = (k, v) => ({ id: 'r' + Math.random().toString(36).slice(2, 8), on: true, k, v });

/* 3 个 collection / 12 个请求，尽量覆盖旧模型的字段形态 */
function legacy() {
  return [
    {
      id: 'c1', name: '用户中心', collapsed: false, requests: [
        { id: 'x1', name: '登录', method: 'POST', url: 'https://api.example.com/login', params: [], headers: [row('Content-Type', 'application/json')], bodyType: 'json', body: '{"user":"demo","pwd":"123456"}', formBody: [] },
        { id: 'x2', name: '查询用户', method: 'GET', url: 'https://api.example.com/users/7', params: [], headers: [row('Authorization', 'Bearer {{token}}')], bodyType: 'none', body: '', formBody: [] },
        { id: 'x3', name: '带查询参数', method: 'GET', url: 'https://api.example.com/users', params: [row('page', '2'), row('size', '20')], headers: [], bodyType: 'none', body: '', formBody: [] },
        { id: 'x4', name: '关闭的行要丢弃', method: 'GET', url: 'https://api.example.com/x', params: [], headers: [{ id: 'h1', on: false, k: 'X-Off', v: '1' }, row('Accept', '*/*')], bodyType: 'none', body: '', formBody: [] },
      ]
    },
    {
      id: 'c2', name: '订单', collapsed: false, requests: [
        { id: 'y1', name: '创建订单', method: 'POST', url: 'https://api.example.com/orders', params: [], headers: [], bodyType: 'form', body: '', formBody: [row('sku', 'A-1'), row('qty', '2')] },
        { id: 'y2', name: '订单详情', method: 'GET', url: 'https://api.example.com/orders/9', params: [], headers: [], bodyType: 'none', body: '', formBody: [] },
        { id: 'y3', name: '删单', method: 'DELETE', url: 'https://api.example.com/orders/9', params: [], headers: [], bodyType: 'none', body: '', formBody: [] },
        { id: 'y4', name: '改单', method: 'PUT', url: 'https://api.example.com/orders/9', params: [], headers: [row('Content-Type', 'application/json')], bodyType: 'json', body: '{\n  "qty": 3\n}', formBody: [] },
        { id: 'y5', name: 'PATCH', method: 'PATCH', url: 'https://api.example.com/orders/9', params: [], headers: [], bodyType: 'text', body: 'plain text body', formBody: [] },
        { id: 'y6', name: 'HEAD', method: 'HEAD', url: 'https://api.example.com/orders/9', params: [], headers: [], bodyType: 'none', body: '', formBody: [] },
      ]
    },
    {
      id: 'c3', name: '示例 · DEMO', collapsed: false, requests: [
        { id: 'z1', name: '用户列表 {{baseUrl}}', method: 'GET', url: '{{baseUrl}}/users', params: [], headers: [], bodyType: 'none', body: '', formBody: [] },
        { id: 'z2', name: '相册(嵌套数据→表格)', method: 'GET', url: '{{baseUrl}}/albums', params: [], headers: [], bodyType: 'none', body: '', formBody: [] },
      ]
    }
  ];
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-migrate-'));
  const store = S.createStore(fsHost(), { dir });
  const old = legacy();

  await ok('迁移后每个 collection 一个 .http，文件名即 collection 名', async () => {
    const r = await S.migrateFromStorage(store, old);
    assert.equal(r.created.length, 3);
    assert.equal(r.skipped.length, 0);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.http')).sort(), ['示例 · DEMO.http', '用户中心.http', '订单.http'].sort());
  });

  await ok('请求数逐个对得上（4 / 6 / 2 = 12）', async () => {
    const a = H.parseHttpFile(fs.readFileSync(path.join(dir, '用户中心.http'), 'utf8'));
    const b = H.parseHttpFile(fs.readFileSync(path.join(dir, '订单.http'), 'utf8'));
    const c = H.parseHttpFile(fs.readFileSync(path.join(dir, '示例 · DEMO.http'), 'utf8'));
    assert.equal(a.requests.length, 4);
    assert.equal(b.requests.length, 6);
    assert.equal(c.requests.length, 2);
    assert.equal(a.requests.length + b.requests.length + c.requests.length, 12);
  });

  await ok('方法 / URL / 请求体一字不差', async () => {
    for (const col of old) {
      const doc = H.parseHttpFile(fs.readFileSync(path.join(dir, col.name + '.http'), 'utf8'));
      col.requests.forEach((src, i) => {
        const dst = doc.requests[i];
        assert.equal(dst.method, src.method, col.name + ' / ' + src.name + ' 方法');
        const expectBody = (src.bodyType === 'form' && !src.body)
          ? src.formBody.filter((r) => r.on !== false && String(r.k || '').trim()).map((r) => r.k + '=' + r.v).join('&')
          : src.body;
        assert.equal(dst.body, expectBody, col.name + ' / ' + src.name + ' 请求体');
        if (src.params.length) {
          assert.equal(dst.url, src.url + '?page=2&size=20', '参数行应折进查询串');
        } else {
          assert.equal(dst.url, src.url, col.name + ' / ' + src.name + ' URL');
        }
      });
    }
  });

  await ok('标题保留；关掉的头/参数行被丢弃', async () => {
    const doc = H.parseHttpFile(fs.readFileSync(path.join(dir, '用户中心.http'), 'utf8'));
    assert.equal(doc.requests[0].title, '登录');
    assert.equal(doc.requests[0].name, '登录');
    const four = doc.requests[3];
    assert.deepEqual(four.headers.map((h) => h.k), ['Accept'], 'on:false 的头不应写进文件');
  });

  await ok('json/form 缺 Content-Type 时补一条，解析回来 bodyType 不退化', async () => {
    const order = H.parseHttpFile(fs.readFileSync(path.join(dir, '订单.http'), 'utf8'));
    assert.equal(order.requests[0].bodyType, 'form');
    assert.equal(order.requests[0].body, 'sku=A-1&qty=2', 'formBody 拼成 urlencoded');
    const put = order.requests[3];
    assert.equal(put.bodyType, 'json');
    assert.match(put.body, /\n {2}"qty": 3/);
    assert.ok(put.headers.some((h) => /^content-type$/i.test(h.k) && /json/i.test(h.v)));
  });

  await ok('变量 {{baseUrl}} 原样保留，未展开', async () => {
    const demo = H.parseHttpFile(fs.readFileSync(path.join(dir, '示例 · DEMO.http'), 'utf8'));
    assert.equal(demo.requests[0].url, '{{baseUrl}}/users');
  });

  await ok('再跑一次：幂等，不新建文件、不重复写', async () => {
    const before = fs.readdirSync(dir).sort();
    const r = await S.migrateFromStorage(store, old);
    assert.equal(r.created.length, 0);
    assert.equal(r.skipped.length, 3);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.http')).sort(), before.filter((n) => n.endsWith('.http')).sort());
  });

  await ok('目标文件已存在：不覆盖，旧 JSON 留档到 .apifox-migrate/', async () => {
    const p = path.join(dir, '用户中心.http');
    const mine = '# 我自己写的\n### 手写接口\nGET https://me.local/x\n';
    fs.writeFileSync(p, mine, 'utf8');
    const r = await S.migrateFromStorage(store, old);
    assert.equal(fs.readFileSync(p, 'utf8'), mine, '用户的文件不能被覆盖');
    assert.ok(r.archived.some((a) => a.endsWith('.apifox-migrate\\用户中心.json') || a.endsWith('.apifox-migrate/用户中心.json')));
    const archived = JSON.parse(fs.readFileSync(r.archived[0], 'utf8'));
    assert.equal(archived.requests.length, 4, '留档里要保住完整旧数据');
  });

  await ok('集合名为空/含非法字符时也能落盘', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wpa-migrate2-'));
    const s2 = S.createStore(fsHost(), { dir: d2 });
    const r = await S.migrateFromStorage(s2, [{ name: 'a/b:c', requests: [{ name: 'q', method: 'GET', url: 'https://x/y' }] }, { name: '', requests: [] }]);
    assert.equal(r.created.length, 2);
    const names = fs.readdirSync(d2).sort();
    assert.ok(names.includes('a_b_c.http'));
    assert.ok(names.includes('collection-2.http'));
    fs.rmSync(d2, { recursive: true, force: true });
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + pass + ' checks passed');
}

main().catch((e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
