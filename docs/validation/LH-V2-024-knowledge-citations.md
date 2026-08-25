# LH-V2-024 企业知识引用验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 企业知识查询使用设备授权和租户边界，结果转换为带来源引用的产品数据。
- Agent 只能读取明确绑定的知识范围；请求、缓存和 UI 均不暴露服务凭据或本机路径。
- “我的”入口与真实产品窗口完成知识查询/引用交互接入。

## 证据

- `apps/longhub-desktop/src/knowledge-client.ts`
- `apps/longhub-desktop/src/user-data-center-service.ts`
- `apps/longhub-desktop/test/knowledge-personal-profile.test.ts`
- Cloud 知识与契约测试包含于 `pnpm ci:full`。
