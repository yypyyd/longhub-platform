# LongHub Portal

Portal 是公开下载、Cloud Skill 订阅和账号设备绑定页面。免费 Manager 是第一视觉入口；Cloud Plugin 与 `longhub-cloud` CLI 是独立收费发布面，不进入 Manager 安装包。

## 用户流程

1. 在下载页获取仅带 `product_surface=longhub-manager` 的 Manager release。
2. 需要 Cloud Skill 时安装已签名的 `longhub-cloud` CLI。
3. 运行 `longhub-cloud pair`，把短时配对码提交到 Portal 账号页。
4. CLI 使用独立 Cloud Plugin release 安装插件；订阅、binding、额度和执行仍由 Cloud API 控制。

Portal 从不接收 device token、普通 `device.json` 或本地 OpenClaw 配置，也不嵌入 OpenClaw Control UI。Cloud Skill 订阅失效只影响云端执行，不限制用户本地 OpenClaw。

## 下载门禁

Manager 下载只接受 `product_surface=longhub-manager`。CLI 下载使用 `longhub-cloud-cli` release surface，显示 SHA-256 和 signing key ID；paused、部分灰度、撤回或错误产品身份都不会显示可下载按钮。Plugin `tgz` 不嵌入 Manager 包。

## 开发

```powershell
pnpm --filter longhub-portal typecheck
pnpm --filter longhub-portal build
```

默认使用同源 `/v1` API，可用 `VITE_API_BASE` 联调。真实支付、生产签名和 Windows VM 配对/install/update E2E 通过前，页面不会宣称产品已生产开放。
