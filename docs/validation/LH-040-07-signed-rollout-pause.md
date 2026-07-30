# LH-040-07 签名灰度与暂停发布验收

日期：2026-07-30

版本：0.4.0 开发分支

结论：签名灰度与暂停事务代码已完成；未部署、未提交、未推送，线上仍为 0.3.7。

## 目标

灰度比例和暂停不能只是 Cloud 数据库中的未签名字段。否则缓存、代理或被控制的更新源可以重放旧的
active 响应，让客户端绕过后台暂停。本项将发布策略放入 Ed25519 manifest，并复用全局单调 sequence
和客户端防回滚状态建立可验证的运营控制链。

## v2 签名策略

更新契约升级为 `longhub/client-update/v2`，用途域为 `longhub-client-update-v2\n`。rollout 包含：

- `status`：`active` 或 `paused`；
- `basis_points`：0..10000，active 时必须大于 0；
- `seed`：每个版本上传时生成的 256-bit 随机值，后续策略调整保持不变；
- `updated_at`：策略生效时间。

上传完成后默认 paused/0，不会因为安装包存在就直接推送。只有当前渠道最新版本可以修改策略；每次
修改都分配更高全局 sequence、重新签署完整 manifest，并记录管理员审计。历史 v1 或未签名索引只
忽略，不使用当前私钥自动升级，因为服务端不能证明其旧发布时序。

## 确定性 cohort

Desktop 使用 Credential Manager 中稳定设备 ID 计算：

```text
SHA-256("longhub-client-rollout-v1\n" + seed + "\n" + deviceId) mod 10000
```

bucket 小于签名 basis_points 时命中。固定 seed 保证 5% → 25% → 100% 扩大时原 cohort 不退出，
暂停/恢复也不会随机换组。paused 和未命中设备仍保存更高策略 sequence，因此已经见过暂停的客户端
会拒绝更低 sequence 的旧 active 响应。

灰度是稳定性控制，不是授权：本地高权限用户可能修改身份争取命中，但仍不能伪造 Ed25519 元数据、
安装包摘要、Authenticode 签名、设备激活或产品 entitlement。

## 安装前撤回

第一次检查命中后，Desktop 才提示下载并验证制品。用户确认“立即安装”后，协调器在关闭
Core/Gateway/Bridge 前重新获取并验签：

- paused 或设备不再命中：返回 withdrawn；
- 最新版本、文件名、大小、摘要或 URL 已变化：返回 withdrawn；
- 同一制品只扩大灰度并产生更高 sequence：接受最新 metadata，继续快照和安装。

withdrawn 不创建 pending、不保存新快照、不停止当前聊天运行时。该复验关闭了下载期间后台暂停或
换版的竞态窗口，但不能召回已经安装完成的版本。

## 管理端与 Portal

- Admin 上传成功提示“默认暂停”，版本列表展示签名 sequence、状态和灰度比例；
- Admin 提供 5%、25%、100% 和暂停操作，服务端拒绝旧渠道版本、无变化、零比例 active、未知字段、
  缺少写权限和超大请求体；
- Portal 只在 100% active 时显示通用安装包下载；部分灰度只提示由已安装客户端接收，paused 不下载；
- `.exe` 静态 URL 仍可能被已知地址直接访问，因此 Portal 收敛不是访问控制，制品信任仍靠签名。

## 已知限制与后续

- `releases.json` 当前适合单 Cloud API 写者；多写实例前需要共享事务存储或独立发布服务；
- 灰度没有遥测自动熔断，本轮只实现管理员显式暂停；
- 程序级失败自动回滚、上一稳定版安装器库存和状态降级演练由 LH-040-08 完成；
- 正式 Update 公钥、代码签名证书和正式图标仍缺失，信任清单继续保持 pending。

## 验证结果

- 灰度链定向：5 个测试文件、25 项全部通过；
- 全仓：57 个测试文件、250 项通过，4 项 PostgreSQL 外部环境测试按条件跳过；
- 17 个 workspace 的 `typecheck`、`lint`、`build` 全部通过；
- OpenAPI YAML 成功解析，包含 29 条路径；`git diff --check` 通过；
- Pack Schema（10 文件）、Cloud API（15 文件）、Desktop（49 文件）安全扫描均为
  0 Critical/High/Medium/Low；
- 三个模块质量门禁均通过；仅报告 Cloud 三个既有长文件和 Desktop `main.ts` 既有长文件警告；
- 变更门禁通过，README、DESIGN、OpenAPI、Admin、Portal、ROADMAP 和本记录已同步；
- 本机 Node 24.14.0 低于 Desktop 锁定下限 24.15.0，本轮未重打候选包；
- 未部署、未提交、未推送，未覆盖线上 0.3.7，信任清单仍为 pending。
