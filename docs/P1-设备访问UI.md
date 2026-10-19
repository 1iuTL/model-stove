# P1 设备访问 UI（主进程 + 设置页）

> 断点锚点：先读本文件，再读 `git log` 与 `docs/P1-安全接线.md`。
> 代理层（设备鉴权 / 配对 / 限流 / 审计）已在 P1 前半段完成，本阶段把
> 「设备密钥」从 `/v1` 请求层接到外壳设置与设置页。
>
> 本阶段只改：`context-proxy.mjs`（新增 issue 端点）、`src/core/settings.js`
> （`deviceAuth` 字段）、`src/main.js`、`src/preload.js`、`src/index.html`、
> `tools/test_security_wiring.mjs`（追加用例）、新增
> `tools/test_security_ui_wiring.mjs` 与本文件。`src/config.js`、
> `src/core/security.js`、其它 `src/core/*`、`package.json`、`tests/` 其它文件、
> 既有 tools 与其它 docs 均未改动。

## 一、范围与提交

基线：`main` @ `3c42219`（P1 代理层已接线；`npm test` 393/393）。

| commit | 内容 |
|---|---|
| `4321f3a` | `feat(proxy)`：新增 `POST /_security/issue`；`test_security_wiring.mjs` 追加签发用例 |
| `2bd64c3` | `feat(shell)`：`deviceAuth` 设置、代理 env、`security:*` IPC、preload、设置页；新增 UI 接线测试 |
| 本提交 | `docs`：记录端点、交互流程、默认行为、安全取舍与验收 |

## 二、默认行为（`deviceAuth=false`）

- 设置文件新增 `deviceAuth: false`（`SCHEMA_VERSION` 仍为 2；旧文件缺这个键时
  读取回落默认，不需要迁移也能继续用）。
- `startProxy()` **不设置** `PROXY_DEVICE_AUTH`，代理按未启用处理；不传
  `PROXY_DEVICE_AUTH_STRICT`。手机 UI、局域网面板、二维码、bridge token、
  8 MiB 请求体上限、动态端口全部保持原样。
- 设置页的「设备访问」小节可以打开，但签发/配对按钮只在代理在线时可用；
  关闭状态下不会影响任何现有请求。

打开 `deviceAuth` 后：代理只保护 `/v1/*`、`/props`、`/tokenize`、`/embedding`、
`/slots`；页面、面板脚本、`/_bridge/*` 不需要设备密钥；本机回环默认豁免
（本外壳的聊天 webview 不受影响）。设备密钥可以放在 `x-device-key: <key>`，
也可以放在 llama UI 的 API Key 输入框（代理接受 `Authorization: Bearer <key>`）。

状态文件仍由 `PROXY_STATE_DIR` 决定（外壳默认 `paths.logsDir`）：
`devices.json` 与 `audit.jsonl` 不因本次接线换位置。

## 三、新增端点：`POST /_security/issue`

与其它 `/_security/*` 一样，先过 `bridgeAuthorized(req)`（未设置 `PROXY_TOKEN`
时免鉴权），再按 IP 限流；所有响应 `Cache-Control: no-store`。

```http
POST /_security/issue
Content-Type: application/json
x-bridge-token: <token>

{ "name": "手动签发设备" }        // name 可省略
```

成功：

```json
{ "ok": true, "deviceId": "dev_1a2b3c4d", "key": "<64 位 hex>", "name": "手动签发设备" }
```

- `name` 非字符串/空白 → `手动签发设备`；按 Unicode 字符截断到 **64** 个字符。
- `key` 只在这个响应里出现一次：注册表只存 sha256，`/_security/devices` 只返回
  `prefix`，不回显明文 key/hash；响应不写日志、不写审计、不落盘。
- 审计事件使用新增的 **`issue`**（不是 `pair_create`）：`pair_create` 继续表示
  「手机配对码已生成」，`issue` 表示「本机直接签发」；`detail` 固定为
  `POST /_security/issue`，另带 `deviceId` 与来源 IP。明文 key 不进审计。

错误：

| HTTP | error | 触发 |
|---|---|---|
| 400 | `invalid_json` | 请求体不是合法 JSON 对象 |
| 401 | `unauthorized` | bridge token 不对 |
| 405 | `method_not_allowed` | 不是 POST |
| 429 | `rate_limited` | 与其它管理端点共用按 IP 令牌桶 |
| 500 | `internal` | 注册表读写异常（响应不暴露异常文本） |

## 四、设置字段与主进程接线

`src/core/settings.js`：

```js
DEFAULT_SETTINGS.deviceAuth = false;
BOOLEAN_KEYS = ['probe', 'lanMode', 'keepServerOnClose', 'deviceAuth'];
```

`src/main.js`：

1. `startProxy()` 计算 `desiredProxyDeviceAuth()`；只有为 true 时才把
   `PROXY_DEVICE_AUTH: '1'` 放进代理 env（false 时完全不传该变量），并把值写进
   启动日志与 `proxyRuntime` 快照。目标端口、局域网绑定、设备鉴权任一变化时，
   `startProxy({ refresh: true })` 会重启被管代理。
2. `settings:set` 接受 boolean `deviceAuth`；写盘后若值变化且被管代理正在跑，
   记录 shell 日志并调用 `startProxy({ refresh: true })`，返回里带
   `proxyRestarted: true`。外部代理无法代重启，日志会说明需手动重启。
3. 新增 IPC（全部走 `proxyRequest`，自动带 bridge token）：

| 通道 | 参数 | 代理请求 |
|---|---|---|
| `security:issue` | `{ name }` | `POST /_security/issue` |
| `security:pairing` | 无 | `POST /_security/pairing` |
| `security:devices` | 无 | `GET /_security/devices` |
| `security:revoke` | `{ id }` | `POST /_security/revoke` |
| `security:rotate` | `{ id }` | `POST /_security/rotate` |

统一返回 `{ ok: true, data }` 或 `{ ok: false, error, status?, offline? }`。
代理离线时返回 `offline: true` 与明确中文错误，不把异常抛到渲染层。
`__test` 暴露同名函数（`securityIssue` 等）供测试直接调用。

4. `settings:get` / `status` 增加 `deviceAuth`（布尔）；`settings:genkey` 仍是
   llama-server 的 API Key，与设备密钥是两套东西。

`src/preload.js` 暴露：`securityIssue(name)`、`securityPairing()`、
`securityDevices()`、`securityRevoke(id)`、`securityRotate(id)`。

## 五、设置页结构

「局域网访问」小节之后新增「设备访问（局域网）」，复用 `.sec` / `.opt` /
`.warn` / `.note` / `.mini`：

| id | 作用 |
|---|---|
| `optDeviceAuth` | 复选框「启用设备密钥（局域网客户端必须配对）」；说明「关闭 = 现有行为；开启后手机在 llama UI 的 API Key 输入框里粘贴设备密钥」 |
| `btnIssueDevice` | 「生成设备密钥」→ `securityIssue('手动签发设备')` |
| `deviceOnceBox` | 一次性显示 `deviceId` 与 `key`（warn 样式，明确「只显示一次」；不写 localStorage、不 console.log） |
| `btnPairing` | 「生成配对码」→ `securityPairing()` |
| `pairingBox` | 显示 6 位 `code` 与过期时间（本地倒计时未做） |
| `deviceList` | 渲染 `securityDevices` 的 name / prefix / createdAt / lastUsedAt / 已吊销标记 + 「吊销」按钮 |
| `deviceHint` | 代理离线时说明原因并禁用签发/配对按钮；在线时提示当前开关状态 |

设备名来自用户输入，列表全部用 `textContent` 构建，不拼 `innerHTML`。
`loadProxyStatus()` 每 15 秒刷新一次代理状态时会顺带刷新设备列表；吊销成功后
立即重新拉取。原有局域网地址、二维码、防火墙提示区域未动。

## 六、交互流程

1. 打开设置 → 勾选「启用设备密钥」。主进程写设置；若代理由外壳托管，会立刻
   重启代理使 `PROXY_DEVICE_AUTH=1` 生效（状态栏/设备提示会反映）。
2. 两种发放方式：
   - **本机直接签发**：点「生成设备密钥」，把 `key` 粘贴到手机的 llama UI
     API Key 输入框（或脚本的 `x-device-key` / Bearer）。`deviceOnceBox` 关闭或
     刷新页面后无法再次查看。
   - **配对码**：点「生成配对码」，得到 6 位 code 与过期时间；手机/脚本用
     `POST /_pair {code}` 兑换，成功响应里同样只返回一次设备 key。
3. 手机请求 `/v1/*` 时携带设备 key；代理校验通过后转发，并把上游
   `Authorization` 换回 `UPSTREAM_KEY`（没有上游 key 则删除），设备 key 不透传。
4. 设备列表里点「吊销」，该 key 立即 401；列表保留记录并显示「已吊销」。
5. 需要换 key 时可走 `security:rotate`（当前设置页没有放轮换按钮，见限制）。

## 七、安全取舍

- **管理面不新增暴露**：`/_security/issue` 与既有设备管理端点一样受 bridge
  token 保护；token 只由主进程持有，渲染层只走 IPC，不接触 HTTP/token。
- **本机 UI 是信任边界**：能操作设置页的人可以签发设备密钥。这与「能读本机
  文件者不在防线内」一致；设备鉴权防的是同一局域网的其他设备，不是本机用户。
- **key 只出现一次**：明文 key 只在 HTTP 响应/预览框里出现；设置页不持久化，
  代理不写日志/审计/注册表。测试断言设备列表不含明文 key。
- **默认关闭**：不开启时 `/v1`、页面、二维码、代理行为与 P1 接线前一致；不设置
  `PROXY_DEVICE_AUTH` 环境变量，避免任何隐式行为变化。
- **回环豁免保持**：本机 webview/本机进程不需要设备 key（P1 既有规则）。
- **无 TLS**：局域网上的设备 key 仍可能被同网段嗅探；LAN 模式应继续保留
  llama-server 的 `--api-key` 作为最后一道锁。

## 八、测试与验收

新增 `tools/test_security_ui_wiring.mjs`（轻量静态 + electron 桩，不启动 GUI）：

- 用永不 resolve 的 `app.whenReady` 桩加载 `src/main.js`，断言
  `security:issue`、`security:pairing`、`security:devices`、`security:revoke`、
  `security:rotate`、`settings:get`、`settings:set` 已注册且无重名；
- 断言 preload 暴露 5 个新方法并 invoke 对应通道；
- 断言 `index.html` 的 7 个新 id 存在、内联脚本用 `$('id')` 引用、无重复 id；
- 断言 `DEFAULT_SETTINGS.deviceAuth === false`、`BOOLEAN_KEYS` 含 `deviceAuth`、
  `SCHEMA_VERSION` 仍为 2；
- 静态断言 `context-proxy.mjs` 含 `/_security/issue` 且仍先过
  `bridgeAuthorized`，集成测试覆盖了签发与 `issue` 审计。

`tools/test_security_wiring.mjs` 追加 9 项断言：无 token 签发 401、带 token 200、
返回 deviceId/key/name、设备名截断 64、响应 no-store、审计 `issue`、签发 key
访问 `/v1` 200、设备列表能看到该设备且不含明文 key、非法 JSON 400。

验收（Windows，node 24.22，真实执行）：

```text
> node tools/test_security_ui_wiring.mjs          → 全部通过
> node tools/test_security_wiring.mjs             → 全部通过（含 issue 用例）
> npm test                                        → 393 tests / 393 pass / 0 fail
> node tools/test_shell_load.mjs                  → 全部通过
> node tools/check_ui.cjs                         → 全部通过（76 个 id 无重复）
> node tools/test_main_wiring.mjs                 → 全部通过
> node tools/test_catalog_wiring.mjs              → 全部通过
> node tools/test_adoption_wiring.mjs             → 全部通过
> node tools/test_security_p0.mjs                 → 全部通过
```

本阶段没有执行 `npm install`、没有启动 Electron GUI（本环境命名管道受限）、
没有 push。

## 九、未解决 / 已知限制

- **配对码没有手机端兑换界面**：本阶段只提供 `POST /_pair` 与设置页的码显示；
  手机侧仍需脚本或未来的配对页调用。日常使用「本机直接签发」更短。
- **设置页没有「轮换」按钮**：`security:rotate` IPC 已接好，但本轮只要求吊销；
  需要轮换时可从主进程/测试调用，后续再加按钮。
- **设备列表 15 秒刷新**：吊销后立即刷新，但其他窗口/进程签发的设备最多晚
  15 秒出现；没有倒计时，配对码只显示过期时刻。
- **外部启动的代理不会自动重启**：`deviceAuth` 变化时只能提示手动重启，因为
  外壳不是它的所有者。
- **回环豁免**：本机请求不需要设备 key；这不是跨用户边界。
- **无 TLS / 无设备数量上限 / 单进程单写者**：继承 P1 代理层与安全核心的既有
  限制（见 `docs/P1-安全接线.md` 第八节）。
- **审计不是防篡改账本**：`issue` 事件同样只用于运行诊断。
