# 小龙虾（OpenClaw）阶段 0 审计报告

> 对应《龙枢 MVP 落地方案 V1.1》阶段 0 第 1 项：许可证、代码、安全和升级审计。
> 审计日期：2026-07-28。结论摘要沉淀在 `src/index.ts` 的 `UPSTREAM` 常量中。

## 1. 基线确认

| 项 | 结论 | 依据 |
| -- | -- | -- |
| 仓库 | `https://github.com/openclaw/openclaw` | 上游官方仓库，安全策略中确认核心 CLI 与 Gateway 同仓 |
| 基线版本 | `2026.7.2` | 上游 `main` 分支 `package.json` `version` 字段 |
| Node 要求 | `>=22.22.3 <23 \|\| >=24.15.0 <25 \|\| >=25.9.0` | 上游 `package.json` `engines.node` |

## 2. 许可证审计

- 上游许可证为 **MIT**（`package.json` `license` 字段），允许商用、修改、私有分发与再许可。
- 龙枢闭源商用、最小 Fork、二次分发均无许可证障碍；分发时保留上游版权与许可证声明即可。
- 风险：上游依赖树中可能存在非 MIT 传染性许可证的间接依赖，正式集成前需对锁定版本跑一次依赖许可证扫描（纳入制品供应链流水线）。

## 3. 代码与架构审计

- 上游为 local-first 智能体基础设施：核心 CLI + Gateway（WebSocket/HTTP），另含 macOS/iOS/Android 应用与 ClawHub 子项目，龙枢只需要 Gateway 能力面。
- 集成方式已按 ADR-LH-009 落地：龙枢内核只依赖本包 `adapter.ts` 契约（`UpstreamRuntimeAdapter`），不 import 上游内部类型；`openclaw-adapter.ts` 为 Gateway 骨架，`mock-adapter.ts` 用于契约与内核集成验证。
- 上游发布节奏快（CHANGELOG 高频更新），直接依赖内部 API 会被频繁破坏——适配层隔离是必要的，维持最小 Fork、避免深度改造上游。

## 4. 安全审计

- 上游安全策略（SECURITY.md）明确：OpenClaw 面向**可信操作者**，**不是多租户对抗边界**；会话所有权/可见性是易用性特性而非安全边界；"能操作 agent 的人可以让 agent 做任何该 agent 能做的事"。
- 对龙枢的含义：
  - 不能把 OpenClaw Gateway 直接暴露给终端用户或多租户共享；每个用户设备上的 Gateway 只服务本机龙枢内核（127.0.0.1 + token）。
  - 权限收敛必须在龙枢内核完成（技能声明 ∩ 租户策略 ∩ 用户授权 ∩ 任务上下文），不能依赖上游做权限控制。
  - 高价值/敏感操作留在龙枢执行器（L3），不经过上游底座。
- 上游有专职安全维护者与私有披露通道（GitHub Security Advisory + security@openclaw.ai），漏洞响应机制成熟。

## 5. 升级审计

- 上游版本号为日历化版本（如 2026.7.2），无长期支持分支承诺；升级策略：
  1. 锁定基线版本，升级走"新基线验证"流程：适配层契约测试全绿才切换。
  2. 适配层 `adapterVersion` 与上游基线解耦，上游升级不影响龙枢内核契约。
  3. Node 引擎区间较严格，Desktop 打包需内置满足区间的 Node 运行时并随基线升级同步评估。

## 6. 依赖许可证与漏洞扫描（基线 2026.7.2，`pnpm licenses` / `pnpm audit --prod`）

- 生产依赖 980 个包，主体为 MIT(730)/Apache-2.0(131)/BSD/ISC 等宽松许可证。
- 需注意的例外（均为可选渠道/扩展依赖，不在龙枢使用的 Gateway 控制面路径上）：
  - `libsignal` **GPL-3.0**（Signal 渠道）、`@tencent-connect/qqbot-connector` **UNLICENSED**（QQ 渠道）、
    `@anthropic-ai/claude-agent-sdk` / `@github/copilot` 许可证未声明（专有 SDK）。
  - `sharp-libvips` / `codec-parser` LGPL-3.0（动态链接使用，合规可控）；`lightningcss`/`web-push` MPL-2.0（文件级 Copyleft，可控）。
- **合规结论**：龙枢与 Gateway 只经 WebSocket 跨进程通信、不静态链接或打包上游代码，上述例外不传染龙枢；
  若未来随安装包分发上游二进制，必须以 `OPENCLAW_SKIP_CHANNELS=1` 姿态裁剪 Signal/QQ 等渠道依赖或单独法务评审。
- 漏洞扫描：2 个 moderate（`@hono/node-server` 路径穿越 GHSA-frvp-7c67-39w9；`node-tar` 递归失控 GHSA-r292-9mhp-454m），
  均有修复版本，升级基线时消化；无 high/critical。

## 7. 结论与遗留项

- **结论：可用。** MIT 许可证无障碍；适配层隔离方案有效；安全模型与龙枢"单机单用户 Gateway + 内核收敛权限"的用法兼容。
- 遗留项状态：
  - [x] 对锁定基线跑依赖许可证与漏洞扫描（结果见第 6 节）。
  - [x] 按 Gateway WS 协议 v4 补全 `openclaw-adapter.ts` 的握手/会话/消息实现（connect → sessions.create → chat.send + chat 事件流），并以内存假网关契约测试验收（`test/openclaw-adapter.test.ts`）。
  - [x] Windows 下 Gateway 进程托管：`apps/longhub-desktop/src/gateway-supervisor.ts` 按上游 embedding 文档实现启动预设、EX_CONFIG(78) 识别、退避重启与退出回收。
  - [x] 真实 Gateway 端到端联调：在 Linux/Node 22.22.3 上安装上游发布包（openclaw@2026.7.2-beta.5，
    2026.7.2 正式版尚未发 npm），以 token 认证模式拉起本机 Gateway，适配器实跑
    connect 握手 → sessions.create → chat.send → chat 事件流 delta → done 全链路通过
    （模型侧用本机 OpenAI 兼容 stub 服务提供流式输出）。
    联调发现并已修复两处协议细节：connect 的 client.id/mode 是上游封闭枚举
    （嵌入宿主应使用 gateway-client/backend 受信类），session label 网关内全局唯一（需带随机后缀）。
