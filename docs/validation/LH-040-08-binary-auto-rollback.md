# LH-040-08 上一稳定版二进制自动回滚验收记录

> 日期：2026-07-30  
> 状态：代码与自动化验收完成；未部署、未重打候选  
> 线上版本：0.3.7（保持不变）

## 目标

把“安装前状态快照”补成完整的程序回滚闭环。新版本安装前必须已有可信旧版安装器；新版本无法健康
启动时，Desktop 自动恢复 LongHub 专属状态并启动旧安装器，同时阻止同一失败制品被再次自动安装。

## 实现结果

### 签名发布与旧制品获取

- `longhub/client-update/v2` manifest 新增签名字段 `rollback_data_strategy`。
- 当前 Cloud 上传固定声明 `snapshot_required`；没有迁移兼容性证明时不得声明向后兼容。
- 新增 `GET /v1/client-releases/versions/{version}?channel=stable`，按精确版本返回严格签名 envelope。
- 精确版本接口不执行 rollout、不推进 Desktop 最高 sequence，也不会把历史版本当成最新版本。
- 旧未签名或缺少新字段的索引记录继续告警并忽略，不使用当前密钥自动重签。

### 安装器库存与安装事务

- 可信库存位于 `userData/client-updates/installers/{version}/LongHub-Setup-{version}.exe`。
- 目标安装器完成 Ed25519、大小/SHA-256、Authenticode 主体和时间戳验证后，Desktop 还会下载当前
  已安装版本并执行相同验证；任一步失败都不会停止当前聊天或安装新版本。
- 只有目标版本再次在线复验仍处于有效 rollout 后，才停止 Core、Gateway、Bridge，创建 pending 并
  启动 NSIS。
- 新版本健康后再次验证目标安装器，再提升到库存；库存只保留当前版和上一版。

### pending v2 与状态恢复

`longhub/client-update-pending/v2` 严格保存：

- previous/target version；
- target/rollback 的完整签名 metadata 与安装器绝对路径；
- snapshot path、attempts、created_at；
- `installing_update` / `rollback_launched` phase；
- rollback reason、failed-state path 和 rollback launch time。

v1、未知字段、无效版本、越界路径、符号链接、特殊文件或缺失的回滚安装器都会失败关闭。快照和恢复
只覆盖 LongHub 固定状态项：`openclaw`、`packs`、Agent Registry、Pack trust keys、设备状态和更新
sequence；用户独立安装的 OpenClaw 不在集合内。

恢复先把失败状态移到 `client-updates/failed-states`，再复制安装前快照。pending 会先持久化固定的
failed-state 路径，恢复中途崩溃后可重复执行；已备份状态不会被覆盖，已恢复状态会重新从快照生成。

### 自动触发与坏版本抑制

- 目标版本每次启动将 attempts 加一；第三次仍未健康时立即回滚。
- 启动后 180 秒内真实 OpenClaw 聊天 WebUI 未健康也会触发回滚。
- 回滚 single-flight 执行，启动旧安装器前再次验证旧 metadata、摘要和 Authenticode。
- 旧版本启动且识别 `rollback_launched` 后写 `last-rollback.json`、清除 pending 并保留诊断状态。
- 更新检查命中 `last-rollback.target_version` 时返回 `rollback_blocked`；rollout sequence 变化不能解除，
  只有更高版本才能继续提示。

## 自动化证据

- Pack Schema：数据回滚策略属于签名载荷，篡改后验签失败。
- Cloud：精确版本接口按渠道返回签名 metadata，暂停状态不影响取回，非法渠道和缺失版本失败。
- Desktop Verifier：精确历史版本不受灰度影响；刚回滚的坏版本被抑制，更高版本仍可更新。
- Desktop Recovery：第三次启动失败触发阈值；失败状态留存；快照恢复可重复执行；旧版本启动确认回滚。
- Desktop Coordinator：旧安装器的获取、下载和验证发生在停机前；缺少可信旧制品无法越过事务边界。
- OpenAPI、Admin 类型与展示、Desktop/Cloud 设计文档和路线图同步。

## 验证结果

- 全仓 57 个测试文件、253 项通过；4 项 PostgreSQL 外部环境测试按条件跳过。
- 17 个 workspace 的 `typecheck`、`lint`、`build` 全部通过。
- OpenAPI YAML 成功解析，包含 30 条路径；`git diff --check` 通过。
- Pack Schema（10 文件）、Cloud API（15 文件）、Desktop（49 文件）安全扫描均为
  0 Critical/High/Medium/Low。
- 三个模块质量门禁通过；Cloud 仅报告三个既有长文件，Desktop 仅报告既有 `main.ts` 长文件警告。
- 变更门禁通过；README、DESIGN、OpenAPI、Admin、Pack Schema、ROADMAP 和本记录已同步。

本记录不伪造尚未取得的代码签名、正式 Update 公钥、正式图标或生产演练审批。

## 上线前置条件与剩余外部阻塞

- 仓库内 `update-trusted-keys.json` 仍为 `pending`，正式 Update Ed25519 公钥与审批字段尚未提供。
- 可信 Authenticode 证书主体与正式图标尚未提供。
- 当前 Node 24.14.0 低于 Desktop 打包下限 24.15.0，不能在本机重打候选。
- 线上 0.3.7 没有被本任务覆盖；本轮未连接生产、未上传安装包、未改变 rollout。
- 首个启用本回滚逻辑的版本发布后，下一次自动更新前必须确保该当前版本已存在严格签名 Cloud 记录；
  否则精确版本接口返回失败，Desktop 会阻止安装新版本。
