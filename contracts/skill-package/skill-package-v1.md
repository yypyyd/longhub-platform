# LongHub Skill Package V1（历史/废弃）

> Schema：`longhub/skill-package/v1`  
> 状态：仅供历史审计，不进入 clean-launch  
> 日期：2026-07-30

LongHub 尚未上线，首发不发布、安装、销售或迁移 Skill Package；当前产品使用 Cloud Skill 薄适配器。

## 目的

Skill Package 是“可发现、可安装/启用、可绑定 Agent 的能力引用”，不是任意代码包。V1 只允许：

- `builtin`：龙枢客户端/官方 Pack 已经携带的受信实现，只切换引用和启用状态。
- `declarative`：Pack 内 Markdown/JSON Content 或 JSON Workflow 引用。
- `cloudRef`：后台登记的逻辑服务 ID 与 API 版本，本机不下载服务端实现。

V1 没有 JS、Python、PowerShell、EXE/DLL、npm/GitHub、OpenClaw plugin、MCP、命令、URL、Provider、
Gateway、API Key、环境变量或原生入口字段。

## 顶层结构

| 字段 | 约束 |
|---|---|
| `schemaVersion` | 固定 `longhub/skill-package/v1` |
| `skill` | ID、SemVer、类型、publisher 和用户展示；逐层拒绝未知字段 |
| `compatibility` | 最低历史客户端、精确 OpenClaw SemVer、runtime API 主次版本 |
| `binding` | 1—64 个允许的 Agent Profile ID；默认启用标记不等于授权 |
| `schemas` | 可选的 Pack 内 JSON input/output Schema 引用 |
| `capabilities` | 最多 32 个 Skill 依赖与 16 个 Connector 逻辑 ID；不能自依赖 |
| `permissions` | 最多 64 个请求权限；副作用/未知动作必须 `per_execution` |
| `runtime` | `builtin` / `declarative` / `cloudRef` 严格判别联合 |
| `limits` | 包大小、20 步、10 分钟、16 并发与费用硬上限；后台只能收紧 |
| `integrity` | SHA-256、小写 64 hex、publisher key ID 与 Base64 Ed25519 签名 |

## 发布方所有权

Publisher namespace 使用最多五段点分小写名。Skill ID 固定为 `<publisher>.skill.<name>`；例如
`longhub.skill.resume-screen` 只属于 `longhub`。新版本必须与 Registry 已记录的 publisher 一致，不能
通过改 manifest 接管已有 ID。只有 `longhub` namespace 可以声明 `builtin`；签名密钥与 namespace 的
真实归属由 Catalog Store 在发布时再次验证。

## 运行形态

```json
{ "kind": "builtin", "implementationId": "longhub.worker.resume-screen" }
```

```json
{ "kind": "declarative", "format": "content-v1", "entrypoint": "content/SKILL.md" }
```

```json
{ "kind": "cloudRef", "serviceId": "longhub.cloud.knowledge-query", "apiVersion": "1.0" }
```

Declarative 路径使用 Pack 安全相对路径，拒绝盘符、反斜杠、路径穿越和 Windows 设备名。Schema 不会
将 `defaultEnabled`、权限声明、签名或 UI 可见状态解释为执行授权；Core 每次调用仍复验 Agent binding、
Feature Policy、entitlement、预算和确认。
