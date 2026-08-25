# Portal 设计

## 信息架构

```text
首页/下载
  ├─ 免费 LongHub Manager
  └─ 独立 Cloud CLI（仅签名候选开放后显示下载）
Cloud Skill
  ├─ 方案与订阅
  └─ 账号设备/配对码
```

Manager 卡片先于 CLI 卡片渲染，确保免费产品和本地 OpenClaw 边界在首屏可见。CLI 文案明确使用 `longhub-cloud pair`，不再暗示 Manager 生成配对码。

## API 契约

Portal 使用账号认证、`GET /v1/client-releases/latest`、`GET /v1/cloud-cli-releases/latest`、`GET /v1/cloud-skill-plans`、`GET /v1/me/devices`、`POST /v1/me/devices/pair` 和订阅/订单接口。配对 body 只接受短时 pairing code；长期 token 从不离开 CLI Credential Manager。

## 安全与边界

- 前端 fail closed：Manager 和 CLI 分别检查 product surface、rollout、版本、SHA-256 和服务返回的公开字段。
- API 错误映射成稳定用户提示，不显示内部 URL、堆栈、token 或任务 input。
- Portal 不管理本地 Provider、Channels、Agent、插件、MCP、工作区或第三方 Skill。

## 已知限制

支付通道、生产 Ed25519/Authenticode、真实 Portal 配对和 Windows VM E2E 仍是 release gate。当前页面可以展示 paused candidate，但不会开放下载或宣称生产可用。

## 变更历史

### 2026-08-17 - CLI 配对入口

将配对文案和流程从“Manager 生成配对码”改为 `longhub-cloud pair`，新增独立 CLI release 下载，并保持免费 Manager 为首个下载面。
