# LongHub 平台设计

## 产品分层

```text
Windows 用户设备
  ├─ Manager 0.1.1：免费、本地 OpenClaw 管理
  └─ longhub-cloud 0.1.2 + Plugin 0.2.1：独立 Cloud Skill 客户端
                         |
                         v
                      Cloud API
               account / device / release
               subscription / binding / quota
                         |
                         v
                      Executor
```

Manager 与 Cloud 客户端没有进程内、loopback 或安装包依赖。Cloud API 通过平台字段保护执行边界：`windows` Manager bearer 不能访问任务，`openclaw-plugin-windows` 才能创建、查询、取消或订阅事件。

## 本地自由原则

LongHub 不复制 OpenClaw runtime，不接管用户 workspace，不要求账号才能启动本地 Gateway。Cloud subscription、feature policy 或设备 revoke 只能影响 Cloud API 请求，不能停止、删除或限制本地 Provider、Channels、Agent、插件、MCP、第三方 Skill 或会话。

## 发布信任

Manager、Plugin、CLI 使用不同 product surface、固定文件名、release 目录和 Ed25519 key。Cloud API 上传时流式绑定同一份 tgz 的大小/SHA-256/版本并签名 manifest；CLI 使用构建时固定 Plugin 公钥，拒绝线上 key 替换、未知 key、同版本覆盖和未验证 npm 包。所有新版本从 paused 开始，撤回保留审计和历史 bytes。

## 凭据边界

Cloud token 只在 Windows Credential Manager 的独立 namespace 中保存。普通 device metadata 只包含指纹和 device ID；非 Windows 明确返回 `UNSUPPORTED_PLATFORM`。写入后回读，失败回滚旧凭据。日志、环境变量、命令行和普通文件不包含 token。

## 迁移决策

旧 Manager Bridge、enrollment 和 Cloud execution 路由不保留长期双协议。Manager 旧入口 fail closed 并返回 `CLOUD_SKILL_MOVED_TO_PLUGIN`；Cloud API 旧 Manager task bearer 返回 `CLOUD_PLUGIN_DEVICE_REQUIRED` 并写审计。历史设备、订单和审计数据保留，不自动迁移为新执行权限。

## 发布状态

Manager `0.1.0` candidate 继续 paused，`0.1.1` 代码完成但未通过正式 Authenticode 门禁。Cloud Plugin `0.2.1` 与 Cloud CLI `0.1.2` 使用两套生产 Ed25519 key 发布并已完成 Linux、Portal、Windows Credential Manager、真实 OpenClaw 安装/更新/执行 E2E；线上 rollout 为 active。支付供应商正式结算与 Manager Authenticode 仍是各自产品面的独立外部门禁。

## 变更历史

### 2026-08-17 - Manager 与 Cloud Skill 独立拆分

将本地管理、Cloud Plugin、Cloud CLI 和 Cloud API release surface 解耦；新增任务平台 gate、共享 Windows 凭据 namespace、独立签名制品和迁移文档。

### 2026-08-17 - 独立客户端生产补丁

CLI `0.1.1` 修复 Windows `.cmd` 启动，`0.1.2` 对齐真实 OpenClaw inspect provenance；Plugin `0.2.1` 固定构建时支持的 OpenClaw 版本 header。补丁均以不可覆盖新版本发布并完成生产 E2E。
