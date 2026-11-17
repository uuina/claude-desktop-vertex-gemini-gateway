# 从零部署与使用指南（Windows 11）

本文档串联 **GCP Vertex AI → CLIProxyAPI 8.0.66（打补丁编译）→ CC Switch → Claude Desktop（Microsoft Store `3p`）** 整条单链路从零配置到日常切换与排错的全过程。所有配置字段均来自本项目实测可用文件，不依赖未验证猜测；图形界面菜单文字因版本而异，文中仅给出所需字段与校验标准。

---

## 前置准备

在开始前，请确认本机已安装或就绪以下组件：

1. **Windows 11** 与 **PowerShell 7**（`pwsh`）
2. **Git** 与 **Go**（用于拉取 `CLIProxyAPI v8.0.66` 源码、应用补丁并编译）
3. **Node.js**（用于运行 `tests/` 下的离线零费用回归测试）
4. **Microsoft Store 版 Claude Desktop**（`AnthropicPBC.Claude`）
5. **[CC Switch](https://github.com/farion1231/cc-switch)**（桌面端本地路由，监听 `127.0.0.1:15721`）
6. **本机 HTTP 代理**（例如 Clash Verge Rev / Mihomo，默认监听 `127.0.0.1:7897`）

---

## Step 1：准备 GCP 服务账号与 `private/auths/` 凭据

1. 在你的 Google Cloud 项目中启用 **Vertex AI API**（`aiplatform.googleapis.com`）。
2. 创建一个专用 Service Account，授予满足 Vertex 调用的最小权限（本项目实测仅需 `aiplatform.endpoints.predict` 与 `serviceusage.services.use`，可按需附加 IAM 到期条件与 GCP Budget 支出上限），并下载其标准 JSON 密钥文件。
3. 将导出的标准 GCP 密钥字段完整填入 `service_account` 对象，保存到本地 `./private/auths/`（该目录及其中的真实凭据与 `kv.db` 均由 `.gitignore` 严格忽略；**切勿将未填密钥的 `.example.json` 模板直接放进 `./private/auths/`**，否则网关会将其作为真实凭据加载并在调用时报错 `missing pem markers`）：
   - **主模型（Argon）**：参照 [examples/auths/vertex-argon.example.json](../examples/auths/vertex-argon.example.json)，保持 `"type": "vertex"`、`"location": "global"`、`"disable_cooling": true`、`"request_retry": 0`。
   - **可选前缀凭据（Carbon，`carbon-us` 前缀）**：参照 [examples/auths/vertex-carbon-us.example.json](../examples/auths/vertex-carbon-us.example.json)，同样使用 `"location": "global"`，额外增加 `"prefix": "carbon-us"` 以配合网关的 `routing.force-model-prefix: true`。

> 注意：`examples/auths/*.example.json` 中的 `private_key` 占位符请用 GCP 导出的完整 PEM 字符串（含 `-----BEGIN PRIVATE KEY-----` 与 `\n`）替换后再写入 `./private/auths/`。

---

## Step 2：编译带补丁的 `CLIProxyAPI 8.0.66` 并做离线自检

克隆官方 `v8.0.66` 标签源码，应用仓库根目录下的干净补丁 [patches/vertex-malformed-v2.patch](../patches/vertex-malformed-v2.patch)，并编译输出到 `gateway-8.0.66/cli-proxy-api.exe`：

```powershell
# 在本仓库根目录执行（临时源码目录放在仓库外，例如 $env:TEMP）
$repoRoot = (Get-Location).Path
$srcDir = Join-Path $env:TEMP 'CLIProxyAPI-8.0.66-src'
if (Test-Path $srcDir) { Remove-Item $srcDir -Recurse -Force }

git clone --branch v8.0.66 --depth 1 https://github.com/router-for-me/CLIProxyAPI.git $srcDir
git -C $srcDir apply (Join-Path $repoRoot 'patches\vertex-malformed-v2.patch')
Push-Location $srcDir
go build -o (Join-Path $repoRoot 'gateway-8.0.66\cli-proxy-api.exe') ./cmd/server
Pop-Location
```

编译完成后，立即运行离线无费用回归套件（全程连接本机 Mock 上游，**不向 Google 发送任何请求**）：

```powershell
node tests/run-offline.cjs
# 如需额外验证 130 秒上游静默流式保活与断流不重放：
node tests/run-offline.cjs --with-stream
```

预期输出 `ALL_OFFLINE_SUITES_PASSED`。

---

## Step 3：复制并对齐本地配置文件

在仓库根目录复制 3 份模板：

```powershell
Copy-Item guard-config.example.json guard-config.json
Copy-Item private/keys.example.json private/keys.json
Copy-Item private/gateway.example.yaml private/gateway.yaml
```

填写时请核对以下 **4 处强一致校验**（`start-gateways.ps1` 启动前会直接检查前 3 项）：

1. **本地网关密钥一致**：`private/keys.json` 的 `backendKey`、`private/gateway.yaml` 的 `access.api-keys`、以及后续 CC Switch Provider 的 `ANTHROPIC_AUTH_TOKEN` 必须填写同一串本地密钥。
2. **输出上限一致**：`guard-config.json` 的 `maxOutputTokens`（默认 `32768`）必须与 `private/gateway.yaml` 中的 `"generationConfig.maxOutputTokens": 32768` 完全一致。
3. **受保护模型策略一致**：`guard-config.json` 的 `allowedModels` 中列出的每个模型名（例如 `gemini-4-argon`、`gemini-4-carbon`、`gemini-4-hydrogen`），在 `private/gateway.yaml` 中都必须存在 `name: "<model>"` 段落，且 `models.catalog` 指向 `./gateway-8.0.66/models-catalog.json` 以在 `-local-model` 模式下注册 `gemini-4-hydrogen`。
4. **本地 HTTP 代理与长上下文策略**：确认 `private/gateway.yaml` 的 `requests.proxy-url` 为本机实际监听地址 `"http://127.0.0.1:7897"`，并保留 `request-retry: 0`、`disable-cooling: true`、`max-request-body-bytes: 0`、`streaming.keepalive-seconds: 5` 与 `nonstream-keepalive-interval: 0`。

> 可选守卫字段：若你在 `guard-config.json` 中显式配置 `billingCreditPolicyAccepted` 和 `cutoffUtc`，`start-gateways.ps1` 会在 `cutoffUtc` 到期前才允许拉起 `18432`；省略这两个字段时默认允许启动。

---

## Step 4：配置 CC Switch 并对接 `Claude-3p`

1. 在 **CC Switch** 中启用本地代理模式（监听 `127.0.0.1:15721`）并接管 `claude-desktop`。
   - 若 CC Switch 未运行且未安装在默认路径，可在 PowerShell 中设置环境变量 `$env:CCSWITCH_DIR = '你的\CCSwitch\目录'`。
2. 参照 [examples/ccswitch-provider.example.json](../examples/ccswitch-provider.example.json) 在 CC Switch 中配置 `claude-desktop` 供应商的关键字段：
   - **接入地址**：`ANTHROPIC_BASE_URL` = `http://127.0.0.1:18432`
   - **鉴权密钥**：`ANTHROPIC_AUTH_TOKEN` = Step 3 中设定的同一 `backendKey`
   - **协议格式**：`apiFormat: "anthropic"`，`claudeDesktopMode: "proxy"`
   - **模型路由映射（`claudeDesktopModelRoutes`，三款 Gemini 4 在客户端菜单并存）**：
     - `claude-opus-5` → `carbon-us/gemini-4-carbon`（显示标签 `Gemini 4 Carbon · GCP`）
     - `claude-sonnet-5` / `claude-fable-5` → `gemini-4-argon`（显示标签 `Gemini 4 Argon · GCP`）
     - `claude-haiku-5-5`（及 `claude-haiku-4-5`）→ `gemini-4-hydrogen`（显示标签 `Gemini 4 Hydrogen · GCP`）
     - `labelOverride` 建议使用 `Gemini 4 (Argon|Carbon|Hydrogen) · GCP`（`sync-desktop-model-capabilities.ps1` 通过正则 `^Gemini 4 (Argon|Carbon|Hydrogen)` 匹配它们以补充 `maxEffort: "high"`）。
3. 先启动一次 Vertex 模式使 CC Switch 向 `%LOCALAPPDATA%\Claude-3p\configLibrary\` 写入 `inferenceProvider: "gateway"` 配置文件（如无此目录可先启动后再退出补齐）：

```powershell
# 1. 拉起 18432 网关、CC Switch 15721 并以 3p 模式打开 Claude Desktop
.\start-claude-store-vertex.ps1

# 2. 预检 & 写入 Gemini 4 maxEffort=high（写入后重新打开一次 Claude Desktop 生效）
.\sync-desktop-model-capabilities.ps1 -CheckOnly
.\sync-desktop-model-capabilities.ps1
```

---

## Step 5：日常切换与常见故障排查

### 日常命令

```powershell
# 启动 Vertex 3p 镜像模式（自动拉起 18432 网关 + CC Switch 15721）
.\start-claude-store-vertex.ps1

# 切回 Anthropic 官方 1p 模式（需先退出镜像版 Claude 窗口；内置 7897 代理防直连守卫）
.\start-claude-store-official.ps1
```

### 常见报错速查

| 现象 / 报错信息 | 原因与排查方法 |
| :--- | :--- |
| 弹窗提示“正在以【官方模式】/【Vertex 镜像模式】运行中” | 同一时刻只允许运行 `1p` 或 `3p` 其中一种模式；请先完全关闭已打开的 Claude 窗口再切换。 |
| `Claude 官方防直连守卫` 拦截启动 | `127.0.0.1:7897` 未监听或经代理探测 `https://api.anthropic.com` 不通；检查本地代理软件后再启动。 |
| `Native Vertex output cap and budget reservation limit must match.` | `guard-config.json` 的 `maxOutputTokens` 与 `private/gateway.yaml` 的 `"generationConfig.maxOutputTokens"` 不相等。 |
| `Port 18432 is in use by a different or unready service.` | `18432` 被其他进程占用，或现有进程 `/v1/models` 未返回 `allowedModels`（核对 `private/keys.json` 与 `private/auths/`）。 |
| `CC Switch directory not found` | 设置 `$env:CCSWITCH_DIR` 指向包含 `cc-switch.exe` 与 `data\live-state.json` 的目录，或先手动打开 CC Switch。 |
| 工具调用返回 `502` `MALFORMED_FUNCTION_CALL` | 说明本轮模型未先发出任何完整 `tool_use` 即畸形失败；补丁刻意禁止跨凭据重放，直接重新发送或微调提示词即可。若此前已完整发出 `tool_use`，v2 补丁会自动以 `tool_use` 正常收尾。 |
| 长思考超过 3–5 分钟后响应变慢或缓存未命中 | CLIProxyAPI 8.0.66 使用 Vertex 隐式前缀缓存（无显式 `cachedContents`）；在客户端执行 `/compact` 精简上下文即可恢复。 |
