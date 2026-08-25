# LH-V2-026 模型输入能力协商验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- Cloud 新增独立 `/v1/client/model-capabilities` 端点；旧 runtime-config V1 不扩字段并保持兼容。
- Desktop 区分文本与视觉输入能力，不支持时隐藏入口并由后台选模逻辑再次拒绝。
- 协议缺失、未知值、过期或服务拒绝均安全降级为文本能力。

## 证据

- `apps/longhub-desktop/src/model-input-capabilities.ts`
- `apps/longhub-desktop/test/model-input-capabilities.test.ts`
- `contracts/openapi/longhub-cloud-v1.yaml`
- `infrastructure/migrations/018-model-input-capabilities.sql`
