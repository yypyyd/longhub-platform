# LH-SKILL-001 云端 Skill 薄适配器契约验收

> 日期：2026-08-09
> 状态：契约代码完成；原生目录安装事务仍进行中

## 覆盖范围

- `longhub/cloud-skill-adapter/v1` 严格 manifest 与未知字段拒绝。
- 安全相对 JSON Schema 路径；拒绝 URL、路径穿越、Windows 保留名和控制字符。
- canonical JSON + SHA-256 digest；Ed25519 签名、验签和 trusted key map。
- 私密实现/完整提示词/凭据/内部 URL 字段扫描和公开边界投影。
- 未确认的写入、发送、删除、支付权限拒绝。

## 验证命令

```powershell
pnpm --filter @longhub/cloud-skill-adapter typecheck
pnpm --filter @longhub/cloud-skill-adapter test
```

结果：TypeScript 通过，Vitest `5/5` 通过。该记录不宣称适配器已经安装到用户 OpenClaw；安装事务、
撤回和 Manager Bridge 由 `LH-SKILL-002` 覆盖。
