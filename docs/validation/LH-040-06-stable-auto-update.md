# LH-040-06 稳定渠道安全自动更新事务验收

日期：2026-07-29

版本：0.4.0 开发分支

结论：稳定渠道事务代码已完成；未部署、未提交、未推送，线上仍为 0.3.7。

## 完成范围

- Electron Main 从安装包内 `assets/update-trusted-keys.json` 加载固定信任锚，不从网络新增公钥；
- 只有 `approved` 清单启用更新；仓库默认 `pending`、空 key，内部候选保持禁用；
- 聊天 WebUI 真实加载健康后延迟 30 秒检查，后续每六小时检查；
- 元数据通过 Ed25519、渠道/平台、sequence 防回滚验证后，以原生对话框询问是否下载；
- 下载拒绝 HTTP、重定向、跨源、覆盖、错误 Content-Length、超长流和摘要不一致；
- 安装前再次验证安装器大小/SHA-256，以及 Authenticode `Valid`、预期 Subject 和可信时间戳；
- 二次确认后停止 Core、Gateway、Tool Bridge，保存 LongHub 专属状态快照和 pending marker；
- 以 NSIS `/S` 启动安装器；新版本启动累计 attempts，真实 WebUI 健康后清除 pending；
- 快照只包含固定 LongHub 状态项，拒绝符号链接/特殊文件，限制 4 GiB、200,000 文件并保留最近两个。

## 预置信任与公开发布门禁

信任清单字段严格固定，key 只接受 Ed25519 SPKI public PEM，拒绝私钥、RSA、重复 ID、未知字段和
不完整审批。公开构建还必须满足：

1. `status=approved` 且至少一个公钥；
2. `expected_signer_subject`、`approved_by`、`approved_at` 完整；
3. 清单签名主体与 `LONGHUB_EXPECTED_SIGNER_SUBJECT` 一致；
4. ASAR 内清单与源码逐字节一致；
5. 安装器与主程序继续通过正式 Authenticode 门禁。

当前正式 Update 公钥、代码签名证书和正式图标尚未提供，因此清单不得改为 approved，也没有重打或
覆盖现有 LH-040-04 内部候选。正式材料到位后应先发布同时信任旧/新 key 的客户端，再切换 Cloud 私钥。

## 故障与恢复语义

- 验签、下载或 Authenticode 失败发生在停机前，不影响当前聊天运行时；
- 停机后的快照或安装器启动失败会撤销 pending，并重启当前客户端以恢复运行时；
- pending 状态损坏、路径越界或字段异常时 fail-closed：禁用更新，但不阻断当前版本使用；
- 状态快照保护 LongHub userData，不覆盖用户当前状态，也不等价于旧程序安装包；
- 没有上一稳定版安装器库存前，不声明二进制自动回滚已经完成。

## 后续拆分

- LH-040-07：将设备分组、灰度比例、暂停/恢复纳入签名发布策略，避免未签名控制面绕过信任链；
- LH-040-08：建立当前/上一稳定版安装器库存、失败阈值、二进制回滚和状态降级演练。

## 验证范围

- 信任清单 pending/approved、Ed25519、私钥/RSA、重复 key、审批与未知字段；
- 下载成功、缓存复用、Content-Length、超长内容、摘要篡改和不覆盖错误缓存；
- 更新事务顺序、拒绝、single-flight、安装器启动失败撤销 pending；
- 快照、启动尝试、健康确认、损坏 pending；
- Authenticode 状态、主体和时间戳纯校验；
- 发布门禁对 pending、approved、签名主体和 ASAR 信任清单一致性的约束。

## 验证结果

- 更新事务定向：5 个测试文件、21 项全部通过；连同资源路径回归为 6 个文件、24 项通过；
- 全仓：57 个测试文件、246 项通过，4 项 PostgreSQL 外部环境测试按条件跳过；
- 17 个 workspace 包的 `typecheck`、`lint`、`build` 全部通过；`git diff --check` 通过；
- Desktop 安全扫描 49 个文件，0 Critical/High/Medium/Low；
- 质量门禁通过，0 错误、1 个既有 `main.ts` 长文件警告；变更与文档同步门禁通过；
- 本机 Node 24.14.0 低于 Desktop 锁定下限 24.15.0，本轮不使用该环境重打候选包；
- 未部署、未提交、未推送，未覆盖线上 0.3.7，也未删除或改写现有候选安装包。

当前清单仍为 pending；任何人都不得仅为打开功能而提交测试 key、生产私钥或伪造审批字段。
