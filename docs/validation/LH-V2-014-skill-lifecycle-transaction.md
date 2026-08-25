# LH-V2-014 Skill 生命周期事务验收

> 状态：代码完成  
> 日期：2026-07-31

## 结论

- 安装/绑定、启停、升级、回滚、卸载和撤销由单写者队列串行执行。
- 每次变更先保存 Core、Gateway、Registry 快照；失败按 Gateway、Core、Registry 反向补偿。
- 撤销先移除 Core grant，再隐藏 Gateway 视图并标记 Registry，已撤销 Skill 不能重新启用。
- 安装前在线复验 entitlement 与签名；失败不会产生 Registry 写入。

## 证据

`skill-lifecycle-coordinator.test.ts` 4 项覆盖完整生命周期、Gateway 写失败三方恢复、撤销顺序和授权失败；
Registry/runtime policy 联合专项 17 项通过，Node 25.9 Desktop 全量 261 项通过。
