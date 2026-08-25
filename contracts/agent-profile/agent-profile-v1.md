# LongHub Agent Profile V1 契约

> Schema ID：`longhub/agent-profile/v1`  
> 规范实现：`packages/longhub-pack-schema/src/agent-profile.ts`  
> 联合校验：`packages/longhub-pack-schema/src/profile-validation.ts`
>
> 状态：历史/废弃；clean-launch 不发布或迁移 Agent Pack/Profile，Manager 只管理原生 OpenClaw 与 Cloud Skill 适配器。

Agent Profile 是用户在龙枢客户端中一键切换的智能体。Pack Manifest 的
`agentTemplate.profilePath` 必须指向 Pack 内的 JSON Profile；Profile、Manifest 和全部引用文件
共同进入 Pack SHA-256 摘要与 Ed25519 签名。

## 最小示例

```json
{
  "schemaVersion": "longhub/agent-profile/v1",
  "id": "longhub.agent.hr",
  "version": "1.0.0",
  "display": {
    "name": "HR 助理",
    "starterPrompts": ["帮我起草一份招聘 JD"]
  },
  "workspace": {
    "identity": "workspace/IDENTITY.md"
  },
  "capabilities": [
    {
      "id": "longhub.capability.recruitment",
      "skillIds": ["longhub.skill.jd-draft"],
      "permissions": ["connector:hr-api:read"]
    }
  ],
  "openclaw": {
    "skills": ["longhub.skill.jd-draft"],
    "tools": { "allow": ["longhub.jd_draft"], "deny": [] },
    "sandbox": "strict"
  },
  "memory": { "mode": "isolated" },
  "lifecycle": {
    "defaultSessionTitle": "HR 新会话",
    "entitlementExpiryPolicy": "readonly"
  },
  "compatibility": {
    "minManagerVersion": "1.0.0",
    "openclawVersion": "2026.7.1-2",
    "profileMigrationVersion": 1
  },
  "modelPolicyId": "longhub.model.default"
}
```

## 约束

- 所有对象使用严格字段集；未知字段直接拒绝，不能借 Profile 下发任意配置。
- `memory.mode` V1 只能为 `isolated`。
- `modelPolicyId` 只能引用后台逻辑策略；不得包含真实模型、Provider、Base URL 或 API Key。
- 不接受 Gateway URL/Token、插件路径、原生代码入口或任意可执行文件字段。
- workspace、头像和 Profile 路径必须是安全的 Pack 相对路径；禁止绝对路径、盘符、反斜杠、
  `.`/`..` 和 Windows 设备名。
- Profile ID/version 必须与 Manifest `agentTemplate` 一致。
- Profile 必须覆盖 Manifest 中全部 required capability，不能引用未声明 capability。
- 同一 capability 的 permissions 必须在 Profile 与 Manifest 中完全一致。
- 所有 workspace/avatar 引用文件必须存在，并随 Pack 一起签名。
- Profile 与历史 Pack 的 `minManagerVersion` 必须一致；`openclawVersion` 是精确兼容版本。

## 生命周期策略

`entitlementExpiryPolicy` 可取：

- `readonly`：隐藏执行能力，历史会话只读保留。
- `hidden`：从普通用户界面隐藏，数据按租户策略保留。
- `delete`：进入受控删除流程；客户端不得静默删除，必须由更高层策略和确认执行。

## 摘要与签名

摘要输入为规范化的（仅保留供历史审计）：

```text
{
  manifest: Manifest（排除自引用 integrity.digest），
  files: Pack 全部文件
}
```

`integrity.signatureKeyId` 也包含在摘要中。发布服务必须先完成 Manifest/Profile 联合校验，再计算
摘要并签名；桌面端必须在写入暂存目录前重复联合校验和验签。
