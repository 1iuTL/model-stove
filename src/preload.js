// model-stove —— 渲染层与主进程之间的桥。
// contextIsolation 已开启,所以渲染层只能看到这里显式暴露的方法。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  /** 取模型 / 预设 / 思考强度清单。 */
  catalogue: () => ipcRenderer.invoke('catalogue'),
  /** 启动服务。
   *  reasoning 为思考强度键名;lanMode 为 true 时监听 0.0.0.0;
   *  budget 为思考预算键名(见 catalogue 的 budgets),缺省用默认档;
   *  ctx 为上下文 token 数(侧栏滑块)。传 null 表示用预设自带的上下文;
   *  kv 为 KV cache 精度键名('q4_0' / 'q8_0'),非法值回落到默认。 */
  start: (modelId, preset, reasoning, lanMode, budget, ctx, kv) =>
    ipcRenderer.invoke('start', { modelId, preset, reasoning, lanMode, budget, ctx, kv }),
  /** 停止当前服务。 */
  stop: () => ipcRenderer.invoke('stop'),
  /** 查询运行状态(是否在跑 / 上下文 / 运行时长)。 */
  status: () => ipcRenderer.invoke('status'),
  /** 读取服务日志末尾。 */
  logs: () => ipcRenderer.invoke('logs'),

  /** 读取本地设置(API Key、局域网开关)和当前可用的局域网地址。 */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /** 写入设置的一部分。 */
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  /** 生成一个新的随机 API Key 并保存。 */
  genKey: () => ipcRenderer.invoke('settings:genkey'),
  /** 重新枚举网卡地址(开热点后需要刷新)。 */
  addresses: () => ipcRenderer.invoke('net:addresses'),

  /** 查压缩代理状态(当前档位、压缩开关、上下文阈值)。代理没跑时返回 offline。 */
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  /** 启动代理(幂等;已经有一个在服务就直接认领)。 */
  startProxy: () => ipcRenderer.invoke('proxy:start'),
  /** 停止代理(只停本外壳拉起的那只)。 */
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  /** 查防火墙里有没有放行规则(不需要管理员权限)。 */
  firewallStatus: () => ipcRenderer.invoke('proxy:firewallStatus'),
  /** 发起一次提权,把放行规则加上(会弹 UAC)。 */
  allowFirewall: () => ipcRenderer.invoke('proxy:allowFirewall'),
  /** 切换任务档位(推理 / 写作 / 通用 / 代码)。 */
  setProfile: (key) => ipcRenderer.invoke('proxy:setProfile', key),
  /** 开关自动上下文压缩。 */
  setCompression: (enabled) => ipcRenderer.invoke('proxy:setCompression', enabled),

  /** 订阅状态变更(服务意外退出时主进程会通知)。 */
  onStateChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('state-changed', handler);
    return () => ipcRenderer.removeListener('state-changed', handler);
  },
});
