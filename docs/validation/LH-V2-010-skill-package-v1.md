# LH-V2-010 Skill Package V1 验收

> 状态：代码完成  
> 日期：2026-07-30

## 已完成

- 冻结 `longhub/skill-package/v1` 严格契约和 TypeScript/Zod 共享实现。
- runtime 只允许官方 `builtin`、受限 `declarative` 与逻辑 `cloudRef`；未知 kind 拒绝。
- 所有对象逐层拒绝未知字段，不存在脚本、命令、可执行、插件、MCP、URL、模型或凭据入口。
- Publisher namespace 与 `<publisher>.skill.*` 绑定，已有 ID 不能换发布方；非官方 builtin 拒绝。
- 兼容、Agent binding、Schema 引用、依赖/Connector、权限、确认、资源限制和签名元数据均有硬上限。
- 写入及未来未知动作必须逐次确认；Package 权限声明本身不构成授权。

## 自动化证据

`@longhub/pack-schema` typecheck 通过，4 个文件 25 项全部通过；其中新增 9 项覆盖三态 runtime、逐层未知
字段、本地代码/基础设施禁止项、安全路径、ID 所有权/接管、非官方 builtin、写确认、自依赖/重复/限制
与摘要格式。

## 边界

本项只冻结 Package 引用和发布身份契约。Publisher 公钥登记/签名复验、Registry 原子状态、Catalog 分发
与安装事务分别由 011—014 实现；Content/Workflow 内部结构由 030/031 冻结。
