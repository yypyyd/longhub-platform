# LH-V2-011 Skill Registry 与 Agent-Skill Binding 验收

> 状态：代码完成  
> 日期：2026-07-30

## 已完成

- 独立 `longhub/skill-registry/v1`，不修改签名 Agent Pack 或 Agent Registry。
- Skill ID/publisher、版本集合、active/previous 和不可变同版本摘要持久化。
- `(agentId, skillId)` 独立 binding；稳定 agentId 必须匹配 Profile，Package 必须允许该 Profile。
- Cloud origin + device scope 只落 SHA-256 owner hash；跨 owner 文件拒绝加载。
- 0600 临时文件原子提交并保留上一个严格备份；当前损坏回退备份，双损坏安全失败。
- 严格 v0 一次性迁移并补齐时间/版本记录；revision 单调递增。
- 提供深拷贝 snapshot/restore，为 014 的 Gateway/Core/Registry 补偿事务复用。
- Skill Registry current/backup/temp 已纳入 Desktop 受管状态和安全清理白名单。

## 自动化证据

Desktop typecheck 通过。`skill-registry.test.ts` 8 项与 `storage-maintenance.test.ts` 9 项全部通过，覆盖
原子持久化、升级/摘要不可变、跨 Agent/错误映射拒绝、owner 隔离、v0 迁移、单备份恢复、双损坏/未知
字段拒绝和快照 revision 单调。

## 边界

Registry 只记录本机安装/绑定事实，不验证 Catalog 在线审核或 entitlement，也不直接修改 OpenClaw
工具列表。Catalog 分发由 012、三态执行语义由 013、跨 Core/Gateway 的完整事务由 014 实现。
