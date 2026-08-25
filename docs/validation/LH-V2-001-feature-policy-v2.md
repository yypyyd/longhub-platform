# LH-V2-001 Feature Policy V2 验收

> 状态：代码完成  
> 日期：2026-07-30  
> 发布状态：未部署、未发布、未开放

## 交付

- 独立 @longhub/feature-policy workspace 与 longhub/feature-policy/v2 严格契约。
- 封闭 feature ID、作用域目标、受众、风险、限制、数据策略、版本和最长五分钟有效期。
- deny-wins、风险取最高、资源取最小、数据位置只收紧的唯一合并算法。
- required_entitlements / required_permissions 跨层取并集，并与实际授权逐项核对。
- 缺失、未生效、过期和紧急关闭安全失败；稳定拒绝原因不泄露输入。
- runtime-config v1 未修改；Feature Policy HTTP 端点留给 LH-V2-002 独立新增。

## 验证

在 Windows、本地时间 2026-07-30 执行：

| 门禁 | 结果 |
|---|---|
| pnpm --filter @longhub/feature-policy test | 1 文件、13 项通过 |
| pnpm --filter @longhub/feature-policy typecheck | 通过 |
| pnpm --filter @longhub/feature-policy build | 通过 |
| CCG module_scanner | 通过，0 error / 0 warning |
| CCG quality_checker | 4 个代码文件、781 行代码，0 error / 0 warning |
| CCG security_scanner | 5 个文件，0 finding |

## 安全用例

- 未知顶层/entry/limit 字段、非法 scope_id、过长 TTL、宽松时间、重复策略和超大 JSON 均拒绝。
- 全局要求 plan:standard、租户要求 tenant:skills 时，合并结果保留两项而不是变为空。
- 直接访问缺失 feature、过期缓存或 emergency_disabled 策略均不能获得授权。
- audience、tenant、agent 或 Desktop 版本不匹配的策略不参与合并。
- 同一设备的多个有效套餐 scope 可以同时参与收紧合并。

## 后续边界

本项只冻结契约与算法。Store/Admin/OpenAPI、独立 HTTP 端点和每次业务调用复验属于 LH-V2-002；
Desktop 刷新、缓存与紧急失效属于 LH-V2-003。此记录不能作为 Cloud 已部署或用户已开放的证据。
