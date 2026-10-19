// 进程监管层：把"拉起 llama-server → 等就绪 → 收干净"收成一个状态机。
//
// 重构前这套逻辑散在 src/main.js 的 startServer/stopServer 里，有六个问题：
//   1. 端口写死 8091，被占时只能失败；
//   2. spawn 失败靠 `waitForHealth()` 空等 5 分钟才发现；
//   3. exit 事件不校验身份 —— 旧进程/旧代次的事件会污染新进程的状态；
//   4. 就绪判定是纯轮询 /health（1.2 秒一次），日志里的 "listening on" 白白浪费；
//   5. 台账只有 PID，没有启动时间，PID 被复用后可能误杀；
//   6. 停止逻辑没有状态机，重复点击/竞态下会互相覆盖。
//
// 本模块的约定：
//   - 一次 start() 生成一个不可变的 ProcHandle（pid + 启动时间 + exe + argv 指纹
//     + generation）。所有事件都先做 generation 比对，过期事件一律丢弃；
//   - spawn 同步抛错或子进程 error 事件 → 立刻 reject（不等就绪超时）；
//   - 就绪：日志出现 `listening on http://...` 或 /health 返回 200，轮询间隔可配；
//   - 没就绪就退出 / 超时 → 自动收尸并把错误连同日志尾巴抛给调用方；
//   - 停止：先温和 kill，超时后 SIGKILL；台账在启动时写、退出时清。
//
// 依赖全部可注入（spawn / 时钟 / 端口探测 / 台账 / 探测函数），
// 所以可以完全用假进程测试，不需要真的 llama-server。
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const http = require('node:http');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn: nodeSpawn } = require('node:child_process');
const portsDefault = require('./ports');

const STATE = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  ERROR: 'error',
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** argv 指纹：只用于日志/台账比对，不进命令行。 */
function hashArgs(args) {
  return crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
}

/** 日志里显示用的 argv：--api-key 的值必须遮掉。 */
function defaultMaskArgs(args) {
  const out = args.slice();
  for (let i = 1; i < out.length; i++) {
    if (out[i - 1] === '--api-key') out[i] = '<已隐藏>';
  }
  return out;
}

/** 默认健康检查：GET <handle.url>health，2xx/3xx 视为活着。 */
function defaultHealthCheck(handle, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.get(`${handle.url}health`, { timeout: timeoutMs }, (res) => {
        res.resume();
        done(res.statusCode >= 200 && res.statusCode < 400);
      });
    } catch {
      return done(false);
    }
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
  });
}

class Supervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.spawn = options.spawn || nodeSpawn;
    this.fs = options.fs || nodeFs;
    this.path = options.path || nodePath;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || delay;
    this.findFreePort = options.findFreePort || ((opts) => portsDefault.findFreePort(opts));
    this.pidOnPort = options.pidOnPort || ((port, opts) => portsDefault.pidOnPort(port, opts));
    this.pidAlive = options.pidAlive || ((pid) => portsDefault.pidAlive(pid));
    this.killProcess = options.killProcess || ((pid, signal) => process.kill(pid, signal));
    this.processStartTime = options.processStartTime || ((pid) => portsDefault.processStartTime(pid));
    this.readLedger = options.readLedger || ((file) => portsDefault.readLedger(file));
    this.writeLedger = options.writeLedger || ((file, entries) => portsDefault.writeLedger(file, entries));
    this.checkLedgerEntry = options.checkLedgerEntry
      || ((entry, opts) => portsDefault.checkLedgerEntry(entry, opts));
    this.healthCheck = options.healthCheck || defaultHealthCheck;
    this.maskArgs = options.maskArgs || defaultMaskArgs;

    this.logDir = options.logDir || null;
    this.ledgerFile = options.ledgerFile || null;
    this.basePort = options.basePort == null ? portsDefault.DEFAULT_BASE_PORT : options.basePort;
    this.scanRange = options.scanRange == null ? portsDefault.DEFAULT_SCAN_RANGE : options.scanRange;
    this.readyTimeoutMs = options.readyTimeoutMs == null ? 300000 : options.readyTimeoutMs;
    this.readinessPollMs = options.readinessPollMs == null ? 200 : options.readinessPollMs;
    this.killGraceMs = options.killGraceMs == null ? 8000 : options.killGraceMs;
    this.startFailFastMs = options.startFailFastMs == null ? 2000 : options.startFailFastMs;
    this.isReady = options.isReady || null;

    this.state = STATE.IDLE;
    this.handle = null;
    this.child = null;
    this.generation = 0;
    this.lastPort = null;
    this._failStart = null;
  }

  // -------------------------------------------------------------- 查询

  status() {
    const h = this.handle;
    return {
      state: this.state,
      modelId: h ? h.modelId : null,
      preset: h ? h.preset : null,
      pid: h ? h.pid : null,
      port: h ? h.port : this.lastPort,
      url: h ? h.url : null,
      startedAt: h ? h.startedAt : null,
      uptimeMs: h ? Math.max(0, this.now() - h.startedAt) : 0,
      generation: h ? h.generation : null,
      argvHash: h ? h.argvHash : null,
    };
  }

  isCurrent(handle) {
    return !!handle && !!this.handle && this.handle.generation === handle.generation;
  }

  /** 读某个 handle 的日志尾巴（默认当前）。 */
  readLogTail(handle = this.handle, maxLines = 250) {
    if (!handle) return [];
    try {
      const text = this.fs.readFileSync(handle.logFile, 'utf8');
      return text.split(/\r?\n/).filter((l) => l.trim()).slice(-maxLines);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------- 启动

  /**
   * 启动服务并等到就绪。
   *
   * 参数：
   *   exe          可执行文件绝对路径
   *   argsForPort  (port) => string[]，端口由本模块选出后传进来
   *   modelId/preset  仅用于日志与状态展示
   *   readyTimeoutMs  覆盖默认就绪超时
   *
   * 成功返回 status()；失败抛 Error（附 code/signal/logTail）。
   */
  async start(params = {}) {
    const { exe, argsForPort, modelId = null, preset = null } = params;
    const readyTimeoutMs = params.readyTimeoutMs == null ? this.readyTimeoutMs : params.readyTimeoutMs;

    if (!exe) throw new Error('start 需要 exe');
    if (typeof argsForPort !== 'function') throw new Error('start 需要 argsForPort(port) 函数');
    if (this.state === STATE.STARTING || this.state === STATE.READY || this.state === STATE.STOPPING) {
      throw new Error(`当前状态为 ${this.state}，不能启动（先 stop()）`);
    }
    this._setState(STATE.STARTING);

    try {
      // 0. 先收拾上次外壳崩溃后遗留的进程（只杀台账里核对得上的）。
      await this.cleanupLeftovers();

      // 1. 选一个空闲端口（只绑回环）。
      const port = await this.findFreePort({ start: this.basePort, count: this.scanRange });
      if (!Number.isInteger(port)) throw new Error('findFreePort 没有返回整数端口');

      // 2. 由调用方按端口拼参数（argv 语义仍归 config/args 层）。
      const args = argsForPort(port);
      if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
        throw new Error('argsForPort(port) 必须返回字符串数组');
      }

      // 3. 可执行文件预检 —— 比等 spawn 报错更早、错误更明确。
      if (!this.fs.existsSync(exe)) throw new Error(`可执行文件不存在: ${exe}`);

      // 4. 每次启动一个独立日志文件，日志面板只看当前这个。
      const generation = ++this.generation;
      const logFile = this._logFileFor(modelId, generation);
      const shown = this.maskArgs(args);
      this._appendText(logFile, `[shell] ${new Date(this.now()).toISOString()}\n[shell] ${exe}\n[shell] ${shown.join(' ')}\n`);

      // 5. spawn。stdio 写文件，不用管道：受限环境下管道会让 Electron 主进程原生崩溃。
      let out = null;
      let child;
      try {
        out = this.fs.openSync(logFile, 'a');
        child = this.spawn(exe, args, {
          windowsHide: true,
          detached: true,
          stdio: ['ignore', out, out],
        });
      } finally {
        if (out != null) { try { this.fs.closeSync(out); } catch {} }
      }

      // 6. spawn 没给 PID：等 error 事件（ENOENT/EACCES 等），最多 2 秒。
      if (!child || !Number.isInteger(child.pid)) {
        const err = await this._waitSpawnError(child);
        throw new Error(`无法启动 ${exe}: ${err.message}`);
      }

      // 7. 建不可变句柄。之后所有事件都靠 generation 认领。
      const handle = Object.freeze({
        pid: child.pid,
        startedAt: this.now(),
        exe,
        argvHash: hashArgs(args),
        args: shown,
        port,
        generation,
        logFile,
        url: `http://127.0.0.1:${port}/`,
        modelId,
        preset,
      });
      this.handle = handle;
      this.child = child;
      this.lastPort = port;
      this._writeCurrentLedger();

      try { child.unref && child.unref(); } catch {}

      // 8. 失败/退出与就绪轮询赛跑。
      let rejectStart;
      const failure = new Promise((_, reject) => { rejectStart = reject; });
      failure.catch(() => {}); // 没被 race 消费时也不要变成未处理拒绝
      this._failStart = rejectStart;

      child.once('error', (err) => {
        if (!this.isCurrent(handle)) return;
        if (this._failStart) {
          this._failStart(Object.assign(new Error(`启动子进程失败: ${err.message}`), { cause: err }));
        }
      });
      child.once('exit', (code, signal) => this._onExit(handle, code, signal));

      await Promise.race([this._pollReady(handle, readyTimeoutMs), failure]);
      if (!this.isCurrent(handle)) throw new Error('服务在就绪前退出');
      this._failStart = null;
      this._setState(STATE.READY);
      return this.status();
    } catch (err) {
      await this._abortStart();
      throw err;
    }
  }

  async _waitSpawnError(child) {
    if (!child || typeof child.once !== 'function') {
      return new Error('spawn 未返回子进程对象');
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(new Error(`spawn 没有返回 PID（${this.startFailFastMs}ms 内也没有 error 事件）`));
      }, this.startFailFastMs);
      child.once('error', (err) => { clearTimeout(timer); resolve(err); });
      child.once('exit', () => { clearTimeout(timer); resolve(new Error('子进程在拿到 PID 前就退出了')); });
    });
  }

  async _pollReady(handle, timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (!this.isCurrent(handle)) throw new Error('服务在就绪前退出');
      let ready = false;
      try {
        ready = this.isReady ? await this.isReady(handle) : await this._defaultReady(handle);
      } catch {
        ready = false;
      }
      if (ready) return true;
      await this.sleep(this.readinessPollMs);
    }
    throw new Error(`服务启动超时（${timeoutMs}ms 内没有就绪）`);
  }

  /** 默认就绪判定：先看日志（llama.cpp 就绪时会打印 listening on），再看 /health。 */
  async _defaultReady(handle) {
    try {
      const text = this.fs.readFileSync(handle.logFile, 'utf8');
      if (/listening on\s+https?:\/\//i.test(text)) return true;
    } catch {}
    return !!(await this.healthCheck(handle));
  }

  /** 启动失败后的收尸：清句柄、清台账、杀掉可能半活的子进程。 */
  async _abortStart() {
    const handle = this.handle;
    this._failStart = null;
    this.handle = null;
    this.child = null;
    this._clearLedger();
    if (handle && this.pidAlive(handle.pid)) {
      try { this.killProcess(handle.pid); } catch {}
      let dead = await this._waitDead(handle.pid, this.killGraceMs);
      if (!dead) {
        try { this.killProcess(handle.pid, 'SIGKILL'); } catch {}
        await this._waitDead(handle.pid, 2000);
      }
    }
    this._setState(STATE.ERROR, { message: '启动未完成' });
  }

  // -------------------------------------------------------------- 退出

  _onExit(handle, code, signal) {
    if (!this.isCurrent(handle)) return; // 旧代次的事件：丢弃
    const wasReady = this.state === STATE.READY;
    const wasStarting = this.state === STATE.STARTING;
    const wasStopping = this.state === STATE.STOPPING;
    const tail = this.readLogTail(handle, 20);
    this.handle = null;
    this.child = null;
    this._clearLedger();

    if (wasStarting) {
      const err = Object.assign(new Error(`服务在就绪前退出（code=${code}${signal ? `, signal=${signal}` : ''}）`), {
        code, signal, logTail: tail,
      });
      if (this._failStart) this._failStart(err);
      return; // 由 start() 的 catch 统一置 ERROR
    }
    if (wasStopping) {
      this._setState(STATE.IDLE);
      return;
    }
    this._setState(STATE.ERROR, { code, signal });
    if (wasReady) {
      this.emit('crash', { pid: handle.pid, code, signal, tail, handle });
    }
  }

  // -------------------------------------------------------------- 停止

  /** 停掉当前服务；没有句柄时按"上次端口"认领外部监听者再杀。 */
  async stop(options = {}) {
    const graceMs = options.graceMs == null ? this.killGraceMs : options.graceMs;
    if (this.state === STATE.STOPPING) return { stopped: [], busy: true };

    const handle = this.handle;
    if (handle) {
      const pid = handle.pid;
      this._setState(STATE.STOPPING);
      try { this.killProcess(pid); } catch { /* 已经没了 */ }
      let dead = await this._waitDead(pid, graceMs);
      if (!dead) {
        try { this.killProcess(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
        dead = await this._waitDead(pid, 2000);
      }
      if (this.isCurrent(handle)) {
        this.handle = null;
        this.child = null;
        this._clearLedger();
        this._setState(STATE.IDLE);
      }
      return { stopped: [pid], adopted: false, dead };
    }

    // 没有句柄：可能是外部起的 llama-server 占着上次的端口。
    const adopted = this.lastPort ? this.pidOnPort(this.lastPort) : null;
    if (!adopted) {
      if (this.state !== STATE.IDLE) this._setState(STATE.IDLE);
      return { stopped: [], adopted: false };
    }
    this._setState(STATE.STOPPING);
    try { this.killProcess(adopted); } catch {}
    let dead = await this._waitDead(adopted, graceMs);
    if (!dead) {
      try { this.killProcess(adopted, 'SIGKILL'); } catch {}
      dead = await this._waitDead(adopted, 2000);
    }
    this._setState(STATE.IDLE);
    return { stopped: [adopted], adopted: true, dead };
  }

  async _waitDead(pid, timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (!this.pidAlive(pid)) return true;
      await this.sleep(100);
    }
    return !this.pidAlive(pid);
  }

  // -------------------------------------------------------------- 台账

  /** 收拾上次遗留：台账里有、启动时间核对得上才杀；PID 被复用的一律不碰。 */
  async cleanupLeftovers(options = {}) {
    const graceMs = options.graceMs == null ? 3000 : options.graceMs;
    if (!this.ledgerFile) return { killed: [], skipped: [] };
    const entries = this.readLedger(this.ledgerFile);
    const killed = [];
    const skipped = [];
    for (const entry of entries) {
      const check = this.checkLedgerEntry(entry, {
        startTimeReader: this.processStartTime,
        alive: this.pidAlive,
      });
      if (check.alive && check.same) {
        try { this.killProcess(entry.pid); } catch { /* 可能刚好自己退了 */ }
        const dead = await this._waitDead(entry.pid, graceMs);
        if (!dead) {
          try { this.killProcess(entry.pid, 'SIGKILL'); } catch {}
          await this._waitDead(entry.pid, 1000);
        }
        killed.push(entry.pid);
      } else {
        skipped.push({ pid: entry.pid, reason: check.reason });
      }
    }
    this._clearLedger();
    return { killed, skipped };
  }

  _writeCurrentLedger() {
    if (!this.ledgerFile) return;
    try {
      this.writeLedger(this.ledgerFile, this.handle ? [this.handle] : []);
    } catch { /* 台账写不了不该阻断服务 */ }
  }

  _clearLedger() {
    if (!this.ledgerFile) return;
    try { this.writeLedger(this.ledgerFile, []); } catch {}
  }

  // -------------------------------------------------------------- 内部

  _logFileFor(modelId, generation) {
    if (!this.logDir) throw new Error('Supervisor 需要 logDir');
    this.fs.mkdirSync(this.logDir, { recursive: true });
    const safe = String(modelId || 'server').replace(/[^\w.-]+/g, '_');
    return this.path.join(this.logDir, `server-${safe}-g${generation}.log`);
  }

  _appendText(file, text) {
    try {
      this.fs.mkdirSync(this.path.dirname(file), { recursive: true });
      this.fs.appendFileSync(file, text, 'utf8');
    } catch { /* 日志写不了不该阻断启动 */ }
  }

  _setState(state, extra = {}) {
    this.state = state;
    try {
      this.emit('state', { ...this.status(), ...extra });
    } catch { /* 监听器抛错不影响状态机 */ }
    return state;
  }
}

module.exports = {
  STATE,
  Supervisor,
  hashArgs,
  defaultMaskArgs,
  defaultHealthCheck,
  delay,
};
