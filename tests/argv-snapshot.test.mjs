// 启动 argv 逐字节快照测试。
//
// 背景：现有 6 个模型是在本机实测过安全包线的（上下文上限、KV 精度、
// --n-cpu-moe 档位、采样参数）。核心层重构时哪怕只是参数顺序变了，
// 也可能改变 llama-server 的行为，所以把"今天实际会发出的 argv"
// 整个冻结成 JSON，重构后逐字节比对。
//
// 跑法：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildArgvCases } from './argv-cases.mjs';

const require = createRequire(import.meta.url);
const cfg = require('../src/config.js');
const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/argv-baseline.json', import.meta.url), 'utf8'),
);

const cases = buildArgvCases(cfg);

test('快照用例集合与基线文件一一对应', () => {
  const actual = cases.map((c) => c.id).sort();
  const expected = Object.keys(fixture.cases).sort();
  assert.deepEqual(actual, expected, '用例增删必须显式更新基线文件');
});

test('基线文件里的每一步都是字符串数组', () => {
  for (const [id, args] of Object.entries(fixture.cases)) {
    assert.ok(Array.isArray(args), `${id}: 基线项不是数组`);
    for (const a of args) assert.equal(typeof a, 'string', `${id}: argv 元素不是字符串`);
  }
});

for (const c of cases) {
  test(`argv 逐字节不变：${c.id}`, () => {
    assert.deepEqual(c.args, fixture.cases[c.id]);
  });
}
