# @longhub/pack-schema

LongHub Agent Pack、Agent Profile V1、摘要和签名的共享契约实现。云端发布、桌面安装、Console
和业务 Pack 必须使用本包，不能分别实现宽松解析器。

主要入口：

- `packManifestSchema` / `validatePackManifest`：Pack Manifest 基础校验。
- `agentProfileSchema` / `validateAgentProfile`：严格 Agent Profile V1 校验。
- `validatePackContent`：联合校验 Manifest、Profile、能力权限和引用文件。
- `computePackDigest`：计算覆盖 Manifest 与全部文件的规范摘要。
- `signPackDigest` / `verifyPackSignature`：Ed25519 签名与验签。
- `clientUpdateManifestSchema` / `signClientUpdateManifest` / `verifyClientUpdateMetadata`：使用独立用途域
  签署并严格验证 Windows 客户端更新 v2 元数据，覆盖发布序列、渠道、制品摘要、同源下载路径，
  数据回滚策略，以及暂停状态、灰度基点、固定 cohort seed 和策略更新时间。
- `clientUpdateRolloutBucket` / `isClientUpdateRolloutEligible`：按签名 seed 与稳定设备身份计算
  `0..9999` 确定性 bucket，扩大灰度时保持已命中 cohort 单调。

Profile 正式契约见
[../../contracts/agent-profile/agent-profile-v1.md](../../contracts/agent-profile/agent-profile-v1.md)。

开发校验：

```powershell
pnpm --filter @longhub/pack-schema typecheck
pnpm --filter @longhub/pack-schema test
```

修改契约时必须同步迁移 HR Pack、云端发布、桌面安装测试和正式契约文档。不得放宽危险路径、
未知字段、共享记忆、真实模型配置或任意插件入口限制。
