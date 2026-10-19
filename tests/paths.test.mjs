// 路径层（src/core/paths.js）的单元测试。
//
// 全部在临时目录里跑，不碰真实 %APPDATA%、不扫真实盘符：
// fs.statfs 是注入的，所以"选空闲最大的非系统盘"可以在 CI/沙箱里验证。
//
// 跑法：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paths = require('../src/core/paths.js');

const tmpRoots = [];
function tmpDir(prefix = 'model-stove-paths-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// ---------------------------------------------------------------- splitList

test('splitList：按系统分隔符拆开并去掉空白/空项', () => {
  const sep = path.delimiter;
  assert.deepEqual(paths.splitList(` a ${sep}${sep} b `), ['a', 'b']);
  assert.deepEqual(paths.splitList(''), []);
  assert.deepEqual(paths.splitList(null), []);
  assert.deepEqual(paths.splitList(['x', ' y ', '']), ['x', 'y']);
});

test('splitList：Windows 上分号、类 Unix 上冒号', () => {
  if (process.platform === 'win32') {
    assert.deepEqual(paths.splitList('D:\\a;E:\\b'), ['D:\\a', 'E:\\b']);
  } else {
    assert.deepEqual(paths.splitList('/a:/b'), ['/a', '/b']);
  }
});

// -------------------------------------------------------------- resolveRoots

test('resolveRoots：转绝对路径、去重、保持顺序', () => {
  const a = path.resolve('alpha');
  const b = path.resolve('beta');
  assert.deepEqual(paths.resolveRoots([a, a, b, '']), [a, b]);
  if (process.platform === 'win32') {
    // Windows 路径大小写不敏感，不能出现两条只差大小写的根
    assert.deepEqual(paths.resolveRoots(['D:\\Models', 'd:\\models']), ['D:\\Models']);
  }
});

// ---------------------------------------------------- platformAppDataDir

test('platformAppDataDir：三个平台各自的默认位置', () => {
  assert.equal(
    paths.platformAppDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, homeDir: 'C:\\Users\\x' }),
    'C:\\Users\\x\\AppData\\Roaming',
  );
  assert.equal(
    paths.platformAppDataDir({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\x' }),
    path.join('C:\\Users\\x', 'AppData', 'Roaming'),
  );
  assert.equal(
    paths.platformAppDataDir({ platform: 'darwin', env: {}, homeDir: '/Users/x' }),
    path.join('/Users/x', 'Library', 'Application Support'),
  );
  assert.equal(
    paths.platformAppDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/x/.cfg' }, homeDir: '/home/x' }),
    '/home/x/.cfg',
  );
  assert.equal(
    paths.platformAppDataDir({ platform: 'linux', env: {}, homeDir: '/home/x' }),
    path.join('/home/x', '.config'),
  );
});

// ----------------------------------------------------- suggestModelRoot

function fakeStatfs(table) {
  return (drive) => {
    const free = table[drive];
    if (free === undefined) {
      const e = new Error(`ENOENT: ${drive}`);
      e.code = 'ENOENT';
      throw e;
    }
    return { bavail: free, bsize: 1024 };
  };
}

test('suggestModelRoot：跳过系统盘，选空闲最大的盘下 Models', () => {
  const res = paths.suggestModelRoot({
    platform: 'win32',
    systemDrive: 'C:',
    homeDir: 'C:\\Users\\x',
    driveLetters: ['C', 'D', 'E', 'F'],
    statfs: fakeStatfs({ 'C:\\': 999999, 'D:\\': 100, 'E:\\': 500 }),
  });
  assert.equal(res.source, 'largest-free-drive');
  assert.equal(res.root, path.join('E:\\', 'Models'));
  assert.deepEqual(res.candidates.map((c) => c.drive), ['E:\\', 'D:\\']);
  assert.ok(res.candidates[0].freeBytes > res.candidates[1].freeBytes);
});

test('suggestModelRoot：系统盘跟随 env.SystemDrive', () => {
  const res = paths.suggestModelRoot({
    platform: 'win32',
    env: { SystemDrive: 'D:' },
    homeDir: 'C:\\Users\\x',
    driveLetters: ['C', 'D', 'E'],
    statfs: fakeStatfs({ 'C:\\': 900, 'D:\\': 999, 'E:\\': 100 }),
  });
  assert.equal(res.root, path.join('C:\\', 'Models'), 'C 盘此时不是系统盘，应该成为候选');
});

test('suggestModelRoot：没有任何可用盘时回落 %USERPROFILE%\\Models', () => {
  const home = path.join(tmpDir(), 'home');
  const res = paths.suggestModelRoot({
    platform: 'win32',
    systemDrive: 'C:',
    homeDir: home,
    driveLetters: ['C', 'D'],
    statfs: fakeStatfs({}),
  });
  assert.equal(res.source, 'fallback');
  assert.equal(res.root, path.join(home, 'Models'));
  assert.deepEqual(res.candidates, []);
});

test('suggestModelRoot：非 Windows 直接回落，不扫盘', () => {
  let called = 0;
  const res = paths.suggestModelRoot({
    platform: 'linux',
    homeDir: '/home/x',
    statfs: () => { called++; return { bavail: 1, bsize: 1 }; },
  });
  assert.equal(res.root, path.join('/home/x', 'Models'));
  assert.equal(called, 0);
});

// ------------------------------------------------------------- createPaths

const baseEnv = { SystemDrive: 'C:' };
function quietStatfs() {
  return () => { throw new Error('ENOENT'); };
}

test('createPaths：非便携 → %APPDATA%\\Model Stove，目录结构齐全', () => {
  const install = tmpDir();
  const appData = tmpDir();
  const home = tmpDir();
  const p = paths.createPaths({
    platform: 'win32',
    env: { ...baseEnv, APPDATA: appData },
    homeDir: home,
    installDir: install,
    statfs: quietStatfs(),
  });
  assert.equal(p.portable, false);
  assert.equal(p.dataSource, 'appData');
  assert.equal(p.dataDir, path.join(appData, 'Model Stove'));
  assert.equal(p.logsDir, path.join(p.dataDir, 'logs'));
  assert.equal(p.cacheDir, path.join(p.dataDir, 'cache'));
  assert.equal(p.settingsFile, path.join(p.dataDir, 'settings.json'));
  assert.equal(p.configFile, path.join(p.dataDir, 'config.json'));
  assert.equal(p.siteConfigFile, path.join(install, 'site.json'));
});

test('createPaths：安装目录下有 data/ 就是便携模式', () => {
  const install = tmpDir();
  fs.mkdirSync(path.join(install, 'data'));
  const p = paths.createPaths({
    platform: 'win32', env: baseEnv, homeDir: tmpDir(), installDir: install, statfs: quietStatfs(),
  });
  assert.equal(p.portable, true);
  assert.equal(p.dataSource, 'portable');
  assert.equal(p.dataDir, path.join(install, 'data'));
});

test('createPaths：优先级 env HOME > 便携 > userDataDir > appData', () => {
  const install = tmpDir();
  fs.mkdirSync(path.join(install, 'data'));
  const userData = tmpDir();
  const homeEnv = tmpDir();

  const portable = paths.createPaths({ platform: 'win32', env: baseEnv, homeDir: tmpDir(), installDir: install, statfs: quietStatfs() });
  assert.equal(portable.dataSource, 'portable');

  const user = paths.createPaths({ platform: 'win32', env: baseEnv, homeDir: tmpDir(), installDir: install, userDataDir: userData, statfs: quietStatfs() });
  assert.equal(user.dataSource, 'portable', '便携标记优先于 electron userData');

  const envHome = paths.createPaths({
    platform: 'win32',
    env: { ...baseEnv, MODEL_STOVE_HOME: homeEnv },
    homeDir: tmpDir(),
    installDir: install,
    userDataDir: userData,
    statfs: quietStatfs(),
  });
  assert.equal(envHome.dataSource, 'env');
  assert.equal(envHome.dataDir, path.resolve(homeEnv));

  const noPortable = tmpDir();
  const user2 = paths.createPaths({ platform: 'win32', env: baseEnv, homeDir: tmpDir(), installDir: noPortable, userDataDir: userData, statfs: quietStatfs() });
  assert.equal(user2.dataSource, 'userData');
  assert.equal(user2.dataDir, path.resolve(userData));
});

test('createPaths：默认模型根用自动建议（非系统盘最大空闲）', () => {
  const install = tmpDir();
  const home = tmpDir();
  const p = paths.createPaths({
    platform: 'win32',
    env: baseEnv,
    homeDir: home,
    installDir: install,
    statfs: fakeStatfs({ 'C:\\': 1, 'D:\\': 10, 'E:\\': 20 }),
  });
  assert.deepEqual(p.modelRoots, [path.join('E:\\', 'Models')]);
  assert.equal(p.suggestedModelRoot.source, 'largest-free-drive');
  assert.deepEqual(p.buildRoots, []);
});

test('createPaths：没有候选盘时模型根回落 %USERPROFILE%\\Models', () => {
  const home = tmpDir();
  const p = paths.createPaths({
    platform: 'win32', env: baseEnv, homeDir: home, installDir: tmpDir(), statfs: quietStatfs(),
  });
  assert.deepEqual(p.modelRoots, [path.join(home, 'Models')]);
  assert.equal(p.suggestedModelRoot.source, 'fallback');
});

// --------------------------------------------------------- 配置优先级

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function layeredFixture() {
  const install = tmpDir('model-stove-site-');
  const userData = tmpDir('model-stove-userdata-');
  writeJson(path.join(install, 'site.json'), {
    version: 2,
    models: { roots: ['site-root'] },
    server: { host: '0.0.0.0' },
  });
  writeJson(path.join(userData, 'config.json'), {
    server: { port: 9090 },
    models: { roots: ['data-root'] },
  });
  const cli = path.join(tmpDir('model-stove-cli-'), 'cli.json');
  writeJson(cli, { models: { roots: ['cli-root'] }, server: { window: 1234 } });
  return { install, userData, cli };
}

test('配置优先级：defaults < site < data < env < cli，深度合并且数组整体替换', () => {
  const { install, userData, cli } = layeredFixture();
  const sep = path.delimiter;
  const p = paths.createPaths({
    platform: 'win32',
    env: {
      ...baseEnv,
      MODEL_STOVE_MODELS: `env-a${sep}env-b`,
      MODEL_STOVE_PORT: '9999',
    },
    homeDir: tmpDir(),
    installDir: install,
    userDataDir: userData,
    cliConfigPath: cli,
    statfs: quietStatfs(),
  });

  const v = p.config.values;
  assert.equal(v.version, 2, 'site 层覆盖内置默认');
  assert.equal(v.server.host, '0.0.0.0', 'site 层的 host 保留');
  assert.equal(v.server.port, 9999, 'env 层覆盖 data 层的端口');
  assert.equal(v.server.window, 1234, 'cli 层新增的键');
  assert.deepEqual(v.models.roots, ['cli-root'], '最高层数组整体替换，不拼接');
  assert.deepEqual(v.builds.roots, [], '内置默认仍在');

  const prov = p.config.provenance;
  assert.equal(prov.version, 'site');
  assert.equal(prov['server.port'], 'env');
  assert.equal(prov['server.window'], 'cli');
  assert.equal(prov['models.roots'], 'cli');
  assert.equal(prov['server.host'], 'site');
  assert.equal(prov['builds.roots'], 'defaults');

  assert.deepEqual(p.modelRoots, [path.resolve('env-a'), path.resolve('env-b')],
    '环境变量的模型根优先级最高');
});

test('配置优先级：坏 JSON 不致命，记录 sources 并回落到下层', () => {
  const install = tmpDir();
  const userData = tmpDir();
  writeJson(path.join(install, 'site.json'), { version: 3 });
  fs.writeFileSync(path.join(userData, 'config.json'), '{ this is not json', 'utf8');
  const p = paths.createPaths({
    platform: 'win32',
    env: baseEnv,
    homeDir: tmpDir(),
    installDir: install,
    userDataDir: userData,
    statfs: quietStatfs(),
  });
  assert.equal(p.config.values.version, 3);
  const data = p.config.sources.find((s) => s.label === 'data');
  assert.ok(data, '坏文件也要留下记录');
  assert.equal(data.loaded, false);
  assert.ok(data.error);
});

test('配置优先级：env 即使没有配置文件也能生效', () => {
  const p = paths.createPaths({
    platform: 'win32',
    env: { ...baseEnv, MODEL_STOVE_HOST: '127.0.0.1', MODEL_STOVE_PORT: '8123' },
    homeDir: tmpDir(),
    installDir: tmpDir(),
    statfs: quietStatfs(),
  });
  assert.equal(p.config.values.server.host, '127.0.0.1');
  assert.equal(p.config.values.server.port, 8123);
  assert.equal(p.config.provenance['server.port'], 'env');
  assert.equal(p.config.provenance['server.host'], 'env');
});

// ------------------------------------------------------------- ensureDirs

test('ensureDirs：建数据/日志目录且幂等', () => {
  const install = tmpDir();
  const p = paths.createPaths({
    platform: 'win32', env: baseEnv, homeDir: tmpDir(), installDir: install, statfs: quietStatfs(),
  });
  paths.ensureDirs(p);
  assert.ok(fs.statSync(p.dataDir).isDirectory());
  assert.ok(fs.statSync(p.logsDir).isDirectory());
  paths.ensureDirs(p); // 第二次不应抛
});
