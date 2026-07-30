# LH-036-08 0.3.6 候选版重启、升级、回滚与共存验收

> 日期：2026-07-29  
> LongHub Desktop：0.3.6  
> OpenClaw：2026.7.1-2  
> 候选版内置 Node：25.9.0  
> 结论：状态连续性与内置运行时验收通过；当前制品为未签名内部候选版，不是公开发布版

## 结论

LH-036-08 通过。使用同一份 LongHub `userData` 连续执行 0.3.5 状态启动、0.3.6 激活、Gateway
重启、HR Pack 1.0.0 → 2.0.0 升级、回滚到 1.0.0 和再次启动后，`main` 与 HR 的稳定
`agentId`、workspace、USER 偏好和历史会话均保持不变。一个独立的用户 OpenClaw Gateway 可以与
龙枢内置 Gateway 同时运行；默认端口被占用时龙枢分配新的回环端口，不复用、读取或修改用户实例。

## 连续验收矩阵

| 场景 | 验收结果 | 状态 |
|---|---|---|
| 0.3.5 主助手历史进入 0.3.6 | main session 原内容保留 | 通过 |
| Desktop/Gateway 使用同一 userData 重启 | Registry 不空转变更，main + HR 映射不变 | 通过 |
| HR Pack 1.0.0 → 2.0.0 | 托管 IDENTITY 更新，agentId、USER 与 session 保留 | 通过 |
| HR Pack 2.0.0 → 1.0.0 回滚 | 托管 IDENTITY 回退，agentId、USER 与 session 保留 | 通过 |
| 用户 OpenClaw 已占用首选端口 | 龙枢选择其他回环端口，不连接未知服务 | 通过 |
| 用户 OpenClaw 与龙枢真实 Gateway 并行 | 用户实例只有 main；龙枢实例为 main + HR | 通过 |
| 并行状态下重启龙枢 Gateway | 用户实例持续可用；龙枢双 Agent 与历史保留 | 通过 |
| 用户 `~/.openclaw` 隔离 | 哨兵身份不变，龙枢配置不包含用户实例路径 | 通过 |

自动化入口：

- `apps/longhub-desktop/test/openclaw-candidate-continuity-e2e.test.ts`
- `apps/longhub-desktop/test/openclaw-gateway-smoke.test.ts`
- `apps/longhub-desktop/test/openclaw-selector-e2e.test.ts`

## 候选安装包

内部候选制品：`apps/longhub-desktop/release/LongHub-Setup-0.3.6.exe`

| 检查项 | 结果 |
|---|---|
| 安装包文件版本 | 0.3.6 |
| 安装包大小 | 159,769,538 bytes |
| SHA-256 | `7FA5B45B3A5939D35EF0E4B02B0A1B164090F201BC56F4EDD666C43C662DB3FF` |
| 内置 Node | 25.9.0，符合 OpenClaw engines |
| 内置 OpenClaw | 精确版本 2026.7.1-2 |
| LongHub Tool Bridge | manifest 与 `dist/index.js` 均存在 |
| Desktop 主进程 | `dist/main.js` 存在，一键安装 catalog/navigation/provisioning 编译产物已回读 |

打包使用 Node 25.9.0 直接启动固定 pnpm 11.9.0 入口，避免 Codex 工具自带的 Node 24.14.0 被
`predist` 复制进安装包。最终 `win-unpacked/resources/node-runtime/node.exe` 已回读确认是 25.9.0。

## 全仓验证

- `typecheck`：27/27 tasks 通过。
- `test`：24/24 tasks 通过。
- `lint`：27/27 tasks 通过。
- Desktop：24 个测试文件、96 项测试通过。
- Cloud API：45 项通过，4 项 PostgreSQL 环境测试按预期跳过。
- 真实 OpenClaw：双 Gateway 共存、Gateway 重启、配置读写、`/chat`、Selector 点击 E2E 均通过。

## 数据语义

- Pack 管理 `IDENTITY.md`、`SOUL.md` 和 `AGENTS.md`，升级与回滚可更新这些文件。
- `USER.md` 只在首次激活初始化，升级、回滚和重启均不覆盖。
- workspace、agentDir、session store 由稳定 agentId 定位；升级和回滚只更新版本映射，不迁移或改绑历史。
- 龙枢只使用自己的 `userData/openclaw`、Registry 和 Pack 目录；用户 `~/.openclaw` 不进入发现、恢复或清理范围。

## 发布边界

当前 0.3.6 exe 是内部候选版，尚未配置 Windows 代码签名证书和正式安装图标，因此不能作为公开
下载制品发布。签名、安装图标和真实 Windows 干净虚拟机上的交互式安装/卸载回归属于
`LH-040-01` 发布门禁；不影响本任务对运行时、状态连续性和共存边界的结论。正式发布后仍需按
部署清单清除临时上传/发布备份，但保留上一稳定版正式安装包用于管理员回滚。
