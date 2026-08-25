# `@longhub/cloud-skill-adapter`

LongHub 云端 Skill 的本地薄适配器契约实现。这个包只负责严格校验公开 manifest、计算摘要、签名/验签和
检查私密字段；它不包含云端 Skill 的源码、完整提示词、连接器凭据、内部 URL 或模型路由。

## 使用

```powershell
pnpm --filter @longhub/cloud-skill-adapter typecheck
pnpm --filter @longhub/cloud-skill-adapter test
```

wire shape 以 [cloud-skill-adapter-v1 契约](../../contracts/cloud-skill-adapter/cloud-skill-adapter-v1.md)
为准。manifest 使用严格 snake_case 字段；未知字段、远程 URL、路径穿越、危险权限未确认和私密实现字段
都会被拒绝。适配器的 `service.entry` 只能是 `local-longhub-bridge`，不得让 OpenClaw 或模型直连
Executor。

## 安全边界

- 摘要覆盖 manifest 的规范化公开字段，排除自引用的 digest/signature 后再使用 Ed25519 签名。
- 运行时应使用受信任公钥表选择 `signature_key_id`，不能由目录或适配器自举信任根。
- 适配器可以被用户读取、备份、停用和删除；云端实现始终留在 Cloud Executor。
