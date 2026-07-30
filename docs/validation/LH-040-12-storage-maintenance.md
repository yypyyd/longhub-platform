# LH-040-12 日志轮转与受管状态维护验收记录

> 日期：2026-07-30  
> 范围：LongHub Desktop 0.4.0 工作区  
> 发布状态：仅完成代码与本地验证；未部署、未重打候选、未覆盖线上 0.3.7

## 验收结论

Desktop 已建立有界脱敏 JSONL 日志、严格白名单临时文件清理和受管状态硬上限。清理器不会枚举或
修改用户原有 `~/.openclaw`，也不会为了满足配额删除龙枢内置 OpenClaw 的会话、记忆、workspace、
agentDir、SQLite 状态、Pack、凭据或更新回滚证据。

## 固定策略

| 项目 | 策略 |
| --- | --- |
| 日志格式 | 共享脱敏器处理后的单行 JSONL |
| 日志轮转 | 单文件 5 MiB，active 加 4 个历史文件，共约 25 MiB |
| 临时文件 | 仅固定原子写、下载和 staging 命名，最后修改超过 24 小时 |
| 已完成更新下载 | 超过 7 天且不被 pending 更新引用 |
| 状态统计 | 只统计龙枢固定受管根下普通文件大小，不读取内容、不跟随符号链接 |
| 扫描上限 | 250,000 个文件系统条目；无法完成统计时按固定存储错误安全阻断 |
| 状态硬上限 | 8 GiB；清理后仍超限显示 `STORAGE_QUOTA_EXCEEDED / LH-ST-001` |
| 文件系统余量 | LH-040-13 起至少保留 256 MiB；不足时显示 `STORAGE_SPACE_LOW / LH-ST-002` |
| 清理报告 | 只含计数和字节数，不含文件名、路径或用户内容 |

## 删除与保留边界

允许删除的候选只有：固定格式的回滚/原子写临时文件、未完成更新下载、Pack staging，以及过期且未被
pending 引用的已完成更新下载。删除前验证允许根、条目类型和 realpath；符号链接、junction、非普通
条目与越界目标拒绝。单个删除失败计数后继续启动。

必须保留：所有 OpenClaw 会话与记忆、workspace、agentDir、SQLite 状态，Pack 正式版本和指针，
Registry、Credential 元数据、运行配置，更新 installer 库、完整快照、failed-state，以及 pending 引用的
快照和新旧安装器。用户独立 OpenClaw 目录始终不在扫描根内。

## 自动化证据

- `storage-maintenance.test.ts` 覆盖固定命名/年龄清理、未知文件保留、pending 引用保护、符号链接拒绝、
  配额超限/无法确认配额时不删除会话、日志文件大小与保留数量。
- `product-error-page.test.ts` 覆盖固定 `LH-ST-001` 文案和原始诊断不可注入边界。
- `client-update-coordinator.test.ts` 与既有更新恢复测试共同覆盖 pending、快照和失败状态生命周期。

定向验证：

```text
3 test files passed, 27 tests passed
longhub-desktop typecheck passed
全仓 64 个测试文件、318 项通过，4 项 PostgreSQL 条件跳过
17 个 workspace 的 typecheck、lint、build 全部通过
安全扫描：严重/高/中/低风险均为 0
质量门禁：通过；保留 main.ts 既有文件长度提醒
变更门禁与 git diff --check：通过（仅既有 CRLF 提示）
```

## 尚未执行的发布动作

- 当前 Node 24.14.0 低于 Desktop 打包要求 24.15.0，本轮不重打安装包。
- 正式代码签名证书、正式图标与正式 Update 公钥仍未提供。
- 本轮不部署到 `154.9.26.158`，线上继续保持 0.3.7。
