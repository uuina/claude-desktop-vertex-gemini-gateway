# Claude Desktop × Vertex Gemini Gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2011-0078D6.svg)](docs/SETUP.md)
[![Gateway: CLIProxyAPI 8.0.66](https://img.shields.io/badge/CLIProxyAPI-8.0.66-2EA44F.svg)](gateway-8.0.66/LICENSE)

让 **Microsoft Store 版 Claude Desktop（`3p` 模式）** 稳定接入 **Google Cloud Vertex AI（`locations/global`）** 的开源适配工程：**包含两项 Go 底层协议修复补丁、单链路最小配置模板、`1p/3p` 防直连隔离脚本与离线无费用回归测试套件**。

```text
Claude Desktop (Microsoft Store, 3p mode)
  └─▶ CC Switch (127.0.0.1:15721)
        └─▶ CLIProxyAPI 8.0.66 + v2 Patch (127.0.0.1:18432)
              └─▶ Local HTTP Proxy (http://127.0.0.1:7897)
                    └─▶ Google Cloud Vertex AI (locations/global)
```

---

## 核心贡献与解决的问题

1. **Go 源码级 `MALFORMED_FUNCTION_CALL` 修复补丁（[patches/vertex-malformed-v2.patch](patches/vertex-malformed-v2.patch)）**
   - **请求级错误定性（`VertexMalformedError`）**：阻止 `CLIProxyAPI 8.0.66` 在 Vertex 返回 `MALFORMED_FUNCTION_CALL` 时内部跨凭据重试或误冷却可用凭据，正确统计失败用量，且日志仅输出 SHA-256 脱敏摘要。
   - **流式工具链保全（`CanFinalizeResponseStream`）**：当流中已完整发出合法 `tool_use` 后才出现尾随 `MALFORMED_FUNCTION_CALL` 或提前断流时，自动抛弃尾部畸形片段并以 `tool_use` 正常结束当前轮次，避免中断多步工具调用。
2. **长上下文稳定参数基线（[private/gateway.example.yaml](private/gateway.example.yaml)）**
   - 关闭后台自动重试与瞬态冷却（`request-retry: 0`、`disable-cooling: true`），避免超时后静默重放重复扣费；
   - 开启 `keepalive-seconds: 5` 与 `nonstream-keepalive-interval: 0` 维持长思考保活，并将 `max-request-body-bytes` 设为 `0` 避免大上下文误触发 `413`。
3. **Store 版双模式隔离与防直连守卫**
   - [start-claude-store-vertex.ps1](start-claude-store-vertex.ps1)：动态解析 CC Switch 路径，自动拉起 `18432` 与 `15721` 并以 `3p` 模式启动 Store 版 Claude，若官方 `1p` 模式运行中则弹窗阻止冲突；
   - [start-claude-store-official.ps1](start-claude-store-official.ps1)：切换回官方 `1p` 模式前强制验证 `127.0.0.1:7897` 与 `https://api.anthropic.com` 连通性，防止误直连；
   - [sync-desktop-model-capabilities.ps1](sync-desktop-model-capabilities.ps1)：动态匹配 `Claude-3p` 本地网关配置，为 Gemini 4 模型写入 `maxEffort: "high"`（支持 `-CheckOnly`）。
4. **零云端费用的离线回归测试（[tests/run-offline.cjs](tests/run-offline.cjs)）**
   - 使用本地 Mock 上游完整验证畸形函数调用边界、13 MiB+ 请求体透传、130 秒静默保活与断流禁止内部重放。

---

## 极速开始

完整从零配置步骤（GCP 权限、Auth JSON 封装、Go 编译、CC Switch 映射、常见报错排查）请直接阅读 **[完整部署指南 docs/SETUP.md](docs/SETUP.md)**。简要步骤如下：

```powershell
# 1. 复制配置模板（真实密钥、auth 文件与 .exe 均由 .gitignore 隔离在本地）
Copy-Item guard-config.example.json guard-config.json
Copy-Item private/keys.example.json private/keys.json
Copy-Item private/gateway.example.yaml private/gateway.yaml
# 将标准 GCP Service Account JSON 按 examples/auths/*.example.json 格式保存至 private/auths/

# 2. 基于 CLIProxyAPI v8.0.66 应用补丁并编译至 gateway-8.0.66/cli-proxy-api.exe（详见 docs/SETUP.md）
node tests/run-offline.cjs

# 3. 对齐 CC Switch (15721 -> 18432，参考 examples/ccswitch-provider.example.json) 后启动
.\start-claude-store-vertex.ps1
.\sync-desktop-model-capabilities.ps1
```

---

## 仓库结构与隐私隔离边界

| 类别 | 包含内容 | Git 状态 |
| :--- | :--- | :--- |
| **公开仓库（云端）** | `LICENSE`、`README.md`、[docs/SETUP.md](docs/SETUP.md)、配置与凭据模板（`guard-config.example.json`、`private/*.example.*`、`examples/auths/*.example.json`、`examples/`）、启动同步脚本（`start-*.ps1`、`sync-desktop-model-capabilities.ps1`）、补丁（[patches/vertex-malformed-v2.patch](patches/vertex-malformed-v2.patch)）、离线回归测试 `tests/` | 公开跟踪 |
| **本机私有运行态（本地）** | `guard-config.json`、`private/keys.json`、`private/gateway.yaml`、`private/auths/`（真实 Vertex Auth JSON 与 `kv.db`）、`gateway-8.0.66/*.exe`、`logs/`、`state/`、个人维护记录 | `.gitignore` 严格隔离，不上传 |

<details>
<summary>展开完整公开目录树</summary>

```text
.
├── LICENSE                                  # MIT 开源协议
├── .gitattributes                           # 跨平台换行符规范
├── .gitignore                               # 隐私凭据与本地运行态隔离规则
├── README.md                                # 项目总览（本文件）
├── docs/
│   └── SETUP.md                             # 从零部署、映射与故障排查完整指南
├── examples/
│   ├── ccswitch-provider.example.json       # CC Switch Claude Desktop Provider 配置示例
│   └── auths/
│       ├── vertex-argon.example.json        # Vertex 主凭据 Auth 封装模板
│       └── vertex-carbon-us.example.json    # Vertex carbon-us 前缀 Auth 封装模板
├── guard-config.example.json                # 本地启动与策略模板
├── start-gateways.ps1                       # 启动与校验 18432 CLIProxyAPI 网关
├── start-claude-store-vertex.ps1            # 启动 Vertex 3p 镜像模式
├── start-claude-store-official.ps1          # 启动官方 1p 模式（含 7897 防直连守卫）
├── sync-desktop-model-capabilities.ps1      # 动态同步 Claude-3p 模型思考档位上限
├── private/
│   ├── keys.example.json                    # 本地网关密钥模板
│   └── gateway.example.yaml                 # CLIProxyAPI 8.0.66 单链路最小配置模板
├── gateway-8.0.66/
│   ├── LICENSE                              # CLIProxyAPI 上游 MIT 许可证
│   └── models-catalog.json                  # 含 gemini-4-hydrogen 的本地模型目录表
├── patches/
│   └── vertex-malformed-v2.patch            # Vertex MALFORMED_FUNCTION_CALL Go 源码补丁
└── tests/
    ├── run-offline.cjs                      # 一键离线回归测试入口（零云端费用）
    ├── malformed-regression.cjs             # MALFORMED_FUNCTION_CALL 行为回归用例
    ├── binary-regression.cjs                # 本地网关二进制行为回归用例
    ├── body-limit-regression.cjs            # 大正文无截断回归用例
    ├── stream-lifecycle-regression.cjs      # 长流式保活与生命周期回归用例
    ├── live-smoke.cjs                       # 18432 本地网关冒烟测试
    ├── inspect-proxy-pipe.cjs               # 本地代理管道检查脚本
    └── inspect-local.py                     # 本地配置状态检查脚本
```

</details>

---

## 开源协议与致谢

本项目中的脚本、测试与文档采用 [MIT License](LICENSE) 开源；`gateway-8.0.66/` 对应的上游网关实现遵循 [CLIProxyAPI MIT License](gateway-8.0.66/LICENSE)。

感谢以下优秀开源项目与工具生态对本方案提供的核心能力支持：
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**（MIT License）：提供 OpenAI / Gemini / Claude / Vertex AI 核心协议转换与本地代理网关底座。
- **[CC Switch](https://github.com/farion1231/cc-switch)**：提供桌面端 AI 客户端供应商切换、模型别名映射与本地代理接管能力。
- **Clash Verge Rev / Mihomo 内核**：提供稳定的本地网络代理基础设施。
