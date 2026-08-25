# LH-V2-007 LongHub Desktop 0.5.0 候选验收

> 状态：候选完成（内部未签名候选）  
> 日期：2026-07-30  
> OpenClaw：2026.7.1-2

## 候选制品

| 检查项 | 结果 |
|---|---|
| 安装包 | `apps/longhub-desktop/release/LongHub-Setup-0.5.0.exe` |
| 大小 | 163,103,515 bytes |
| SHA-256 | `0A9F80AB89E16E628AD13DF9A831861A9F79F9E14E3C3ACDD9EC9E4ADB13328E` |
| blockmap SHA-256 | `7627DF11B2716D75A001B9450002286C9ABE2EEBC902FA1538E7AFB0150BB985` |
| 内置 Node | 25.9.0；OpenJS Foundation 签名和 Microsoft 时间戳有效 |
| 内置运行时 | Core、Worker、Tool Bridge、Gateway smoke 全部通过 |
| OpenClaw | `2026.7.1-2 (0790d9f)` |
| ASAR | 15,168,618 bytes；25,898 个 unpacked 文件；依赖闭包在 allowlist 内 |

内部构建明确接受安装器和主程序 `NotSigned`，品牌状态为 `temporary`，更新信任状态为 `pending`；同一
条件会被正式发布命令拒绝。

## 回归证据

- Node 25.9.0 直接启动全量 Desktop：47 个测试文件、237 项全部通过，包含真实 Gateway、Electron、
  Windows Credential Manager、Agent 安装/激活、Selector 会话恢复、候选连续性和 Pack 回滚。
- V2 四档本地回归：单元/契约 7 秒、冒烟 56 秒、安全 6 秒、全量 65 秒，均低于预算。
- PostgreSQL 16 PgStore 七项合同全部通过；Nginx stable 真实 `nginx -t` 成功。
- 类型检查、Lint 和构建通过；OpenAPI 与四份 workflow YAML 可解析。
- CCG 变更门禁通过；质量门禁通过（6 个既有/累积超长文件警告，无错误）；安全门禁 Critical/High/
  Medium 均为 0，唯一 Low 为结构化日志使用标准输出。

## 0.5 发布门槛覆盖

- Feature Policy 关闭同时阻断入口显示、子窗口直接导航和 Cloud API；离线缓存不授予高风险写权限。
- 确认展示与真实输入绑定，批准只能消费一次；拒绝、关闭、过期、重放和跨 Agent 均失败。
- OpenClaw 主 WebUI 继续没有 preload、Node 或通用 IPC；产品窗口使用独立 origin 与最小 bridge。
- per-route P95/5xx、紧急 revision 首拒延迟和外部 availability no-data 已进入运营指标载体。
- Pack 安装、升级、回滚、撤销和候选状态连续性均在全量回归中通过。

## 发布边界

本项证明 0.5.0 内部候选可构建、可复验，不表示已部署、已灰度或公开发布。远端 GitHub Actions 尚未
首次运行；Cloud/Nginx 尚未部署；正式发布仍需要已审批品牌、Authenticode 证书/主体/时间戳、正式更新
信任清单和干净 Windows 环境安装/卸载验收。
