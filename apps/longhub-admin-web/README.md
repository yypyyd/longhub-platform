# LongHub Admin Web

运营后台同时管理免费 Manager 和收费 Cloud Skill 服务，但两个发布面、签名 key 和 rollout 完全独立。

## 页面

- 用户、设备、订阅、entitlement、订单和 Executor 运维。
- Manager release：只接受 `LongHub-Manager-Setup-x.y.z.exe` 与 `product_surface=longhub-manager`。
- Cloud Plugin release：`longhub-openclaw-cloud-plugin-x.y.z.tgz`、`longhub-cloud-plugin` surface。
- Cloud CLI release：`longhub-cloud-cli-x.y.z.tgz`、`longhub-cloud-cli` surface。
- 审计：上传、暂停/灰度、撤回、设备撤销和云端执行拒绝。

Plugin/CLI 上传会显示文件名、版本、大小、SHA-256、签名 key ID 和 paused 状态。版本不可覆盖；撤回保留历史 bytes 与审计。Admin 不上传 Manager 内置插件，也不管理本地 OpenClaw 配置。

## 开发

```powershell
pnpm --filter longhub-admin-web typecheck
pnpm --filter longhub-admin-web test
pnpm --filter longhub-admin-web build
```
