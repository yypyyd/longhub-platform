# LH-V2-008 OpenClaw 会话 API 可行性 Spike

> 状态：代码完成（调研项）  
> 日期：2026-07-30  
> 目标版本：OpenClaw 2026.7.1-2  
> 结论：有稳定公开接口，可继续 LH-V2-020；部分高级能力需龙枢封装或上游扩展

## 锁定版公开能力

以下均为 Gateway 对外声明的 RPC，不需要读取或改写 OpenClaw SQLite、session store 或 transcript 文件：

| 能力 | 公开 RPC | 最小权限/边界 | 020 用途 |
|---|---|---|---|
| 会话索引与分页 | `sessions.list` | `operator.read`；limit/offset、agentId、search、archived | 列表、Agent 过滤、元数据搜索 |
| 单会话详情/预览 | `sessions.describe`、`sessions.preview`、`sessions.resolve` | `operator.read` | 标题、最近消息、稳定定位 |
| 创建会话 | `sessions.create` | `operator.write` | 新建会话 |
| 重命名与归档 | `sessions.patch` | label/category/pinned/archived/unread 仅需 `operator.write`；未知/敏感字段 fail closed | 重命名、归档、恢复归档 |
| 历史读取 | `chat.history`、`chat.message.get` | `operator.read`；limit/offset/maxChars | 分页导出消息 |
| 会话附件引用 | `sessions.files.list`、`sessions.files.get` | `operator.read`；只按会话与显式路径读取 | 后续受限导出附件 |
| 删除 | `sessions.delete` | 普通删除需 admin；`archivedOnly=true` 的 archive-then-delete 可收敛为 write | 021 永久删除阶段 |
| 实时更新 | `sessions.subscribe`、`sessions.messages.subscribe` | `operator.read` | 增量刷新，避免轮询全表 |

请求 Schema 均为 `additionalProperties: false`。`sessions.patch` 的普通组织字段有显式 write 白名单，
模型、执行路由、工具继承等其他字段仍要求 admin；`sessions.delete` 只有 archive-then-delete 参数集可降到
write，未知字段继续 fail closed。

## 真实 Gateway 证据

`openclaw-selector-e2e.test.ts` 在实际启动的 2026.7.1-2 Gateway 上完成：

1. 为 HR Agent 创建两个会话并列出。
2. 重命名、设置 category/pinned，使用 `agentId + search + limit + offset` 找回目标。
3. 通过 `sessions.describe` 读取详情，通过 `chat.history` 的分页/字符上限读取空历史。
4. 带未知字段的 `sessions.list` 被严格拒绝。
5. 先归档再以 `archivedOnly=true` 删除，归档列表不再返回目标。
6. 原生 Selector 仍能恢复未删除的最近会话，停用 Agent 后回退 main。

本次专项：1 文件、1 个真实 Gateway + Electron E2E 通过，用时约 53 秒。

## 缺口与 020/021 设计约束

- `sessions.list.search` 面向会话元数据，不承诺全文 transcript 索引。020 可维护龙枢自己的只读搜索索引，
  但索引内容必须来自公开 RPC，不能读取内部数据库或 JSONL。
- `chat.history` 是 offset 分页，不提供跨页快照令牌。导出期间会话继续写入时可能漂移；020 应记录导出
  起始时间/会话 revision（若响应提供）并在变化时提示重试，不能宣称原子快照。
- 没有单 RPC 的完整导出包。020 需组合 history 与公开 session-file 引用，定义大小、类型、缺失附件和
  脱敏边界；不能把 Gateway 的任意文件读取能力透传给 Renderer。
- OpenClaw 永久删除不提供龙枢要求的回收站和恢复期。021 必须先实现龙枢可恢复状态机，再允许调用
  `sessions.delete`；不能把 `archived=true` 文案包装成已删除。
- 大会话的 derived title、last message 和 history 会做截断/占位。020 必须显式展示“不完整”，不能静默
  当成完整历史。
- API 只冻结到 2026.7.1-2。升级 OpenClaw 时必须由 compat 契约与真实 RPC 回归复核方法、Schema 和权限。

## 上游扩展需求草案

若 020/021 产品验收要求高于上述边界，向 OpenClaw 提交以下最小扩展，不要求私有存储访问：

1. `sessions.export`：按 session key 返回带版本的流式导出，包含稳定 snapshot/revision、消息游标、附件
   manifest、总大小与内容摘要；支持取消和大小上限，不直接返回主机绝对路径。
2. `sessions.search`：公开、分页、Agent scoped 的全文搜索，返回命中 message ID、摘要、时间与稳定游标，
   明确索引一致性和删除传播语义。
3. `sessions.trash` / `sessions.restore`：服务端回收状态、保留截止时间、幂等恢复与永久删除 CAS；永久删除
   继续要求 archive/trash 前置及更高权限。
4. 为 list/history/export 返回稳定 lifecycle revision，并支持 `expectedRevision`，使导出与删除能检测并发修改。

三态判定：基础列表/重命名/归档/元数据搜索/分页历史为“有稳定公开接口”；全文搜索、原子完整导出和
可恢复删除为“需龙枢封装或上游扩展”；LH-V2-020 无需延期，LH-V2-021 不得直接复用永久删除。
