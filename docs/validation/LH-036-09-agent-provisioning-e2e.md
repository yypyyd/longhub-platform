# LH-036-09 已授权未安装 Agent 一键安装验收

> 验收日期：2026-07-29  
> LongHub Desktop：0.3.6  
> OpenClaw：2026.7.1-2  
> 范围：全新 `userData`、`main + longhub.agent.hr`

## 结论

LH-036-09 通过。设备只有云端 HR entitlement、没有任何本地 HR Pack 时，原生 OpenClaw Agent
Selector 会显示“HR 助理（点击安装）”。用户点击一次后，Desktop 完成下载、响应元数据核对、
Ed25519 验签、公钥持久化、Pack 激活和 Gateway 热更新，并直接进入稳定 HR agentId 的专属会话。
整个页面继续没有 preload、Node 或通用 Electron IPC。

## 端到端验收矩阵

| 场景 | 预期 | 结果 |
|---|---|---|
| 全新 userData、云端已授权但未安装 | Selector 出现 HR 安装入口 | 通过 |
| catalog 存在但 entitlement 无效/过期 | 不显示可安装 Agent | 通过 |
| 云端返回未知 Pack | 客户端不映射为 Agent | 通过 |
| 点击 HR 安装入口 | 只产生固定单用途安装导航 | 通过 |
| 安装进行中 | 显示“安装中…”，不重复提交 | 通过 |
| 下载响应与 Manifest 元数据不一致 | 安全失败，不激活 | 通过 |
| 下载制品验签 | 使用云端 key ID 对应 Ed25519 公钥完整验签 | 通过 |
| 公钥持久化或激活失败 | 恢复安装前 active 指针，保留重试入口 | 通过 |
| 安装与激活成功 | 真实 Gateway `agents.list` 回读 main + HR | 通过 |
| 激活完成 | 进入 `agent:<hrAgentId>:main` | 通过 |
| Electron 页面权限 | `hasNode=false`，无 preload/通用 IPC | 通过 |

## 安全边界

- 云端 catalog 与 entitlement 只产生“候选 Pack”；Profile ID、OpenClaw agentId 和显示映射由客户端
  锁定版本定义，真正身份、能力和文件仍来自签名 Manifest/Profile。
- 安装导航仅接受 `longhub-agent://install/?packId=<pack-id>`；额外路径、参数、凭据、fragment、
  其他协议和新窗口全部拒绝。
- Main 只处理当前发现列表中的候选 Pack。下载阶段再次校验 entitlement、版本、digest、
  signature key ID、制品签名和兼容范围，Selector 不是授权边界。
- Core 在每次工具执行前仍在线复验 entitlement 与 Pack 状态；安装成功不等于永久执行授权。
- 安装失败不会删除用户 workspace 或历史会话；新 Pack 激活失败会清除错误 active 指针，后续可重试。

## 自动化证据

- `apps/longhub-desktop/test/agent-pack-provisioning.test.ts`：真实 Cloud API 发布/授权/下载，真实
  OpenClaw Gateway `config.patch`，最终 `agents.list` 回读 main + HR，并检查 Registry、workspace、
  Bridge policy 与持久化公钥。
- `apps/longhub-desktop/test/agent-install-ui-e2e.test.ts`：真实 Electron 点击安装入口，验证固定导航、
  单次提交、成功后 HR 切换和页面无 Node。
- `apps/longhub-desktop/test/agent-install-navigation.test.ts`：固定协议解析与恶意变体拒绝。
- `apps/longhub-desktop/test/agent-pack-catalog.test.ts`：客户端锁定映射、未知 Pack、已安装 Pack、过期、
  撤销和无效授权过滤。
- `apps/longhub-desktop/test/openclaw-selector-policy.test.ts`：安装中、失败重试、策略更新和 Selector
  允许列表行为。

## 全仓验证

- `pnpm typecheck`：27/27 tasks 通过。
- `pnpm test`：24/24 tasks 通过。
- `pnpm lint`：27/27 tasks 通过。
- Desktop：24 个测试文件、96 项测试通过。
- Cloud API：45 项通过；4 项依赖 PostgreSQL 环境的测试按预期跳过。

## 0.3.6 内部候选包

LH-036-09 源码进入候选包后已重新执行 NSIS 打包并回读解包内容：

| 检查项 | 结果 |
|---|---|
| 安装包 | `apps/longhub-desktop/release/LongHub-Setup-0.3.6.exe` |
| 大小 | 159,769,538 bytes |
| SHA-256 | `7FA5B45B3A5939D35EF0E4B02B0A1B164090F201BC56F4EDD666C43C662DB3FF` |
| 内置 Node | 25.9.0 |
| 内置 OpenClaw | 2026.7.1-2 |
| Tool Bridge | manifest 与 `dist/index.js` 均存在 |
| 一键安装产物 | catalog、固定导航、provisioning 与 Main 接入均存在 |

安装包仍未配置 Windows 代码签名证书并使用默认 Electron 图标，因此只作为内部候选版。

## 后续

0.3.6 的 `main + HR` 纵向功能闭环至此完成。下一项为 `LH-037-01`：建立版本化
`openclaw-compat`，集中管理 OpenClaw 版本、配置、路由、Selector 与 DOM/CSS 依赖，并增加固定
窗口截图回归。公开发布仍受 Windows 代码签名证书和正式安装图标门禁约束。
