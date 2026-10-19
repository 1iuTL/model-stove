// 从当前 src/config.js 生成 argv 基线快照。
//
// 只应该在两类时机跑：
//   1. 首次建立基线（本次重构之前）；
//   2. 用户明确要求改变某个模型的启动参数（此时基线的变化要在提交里被审阅）。
//
// 平时**不要**跑它 —— tests/argv-snapshot.test.mjs 的作用就是拦住
// "重构顺手改了命令行却没人发现"，随手重新生成会让这道闸门失效。
//
// 用法：node tools/gen_argv_baseline.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { buildArgvCases } from '../tests/argv-cases.mjs';

const require = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..');
const cfg = require(path.join(REPO, 'src', 'config.js'));

const cases = buildArgvCases(cfg);
const out = {
  note: '由 tools/gen_argv_baseline.mjs 从 src/config.js 生成；重构成核心层后 argv 必须逐字节不变。',
  source: 'src/config.js',
  cases: Object.fromEntries(cases.map((c) => [c.id, c.args])),
};

const dir = path.join(REPO, 'tests', 'fixtures');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'argv-baseline.json');
fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`写入 ${path.relative(REPO, file)}：${cases.length} 个用例`);
