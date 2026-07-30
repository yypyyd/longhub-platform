# LongHub Desktop

龙枢 Windows 客户端宿主。它直接显示内嵌 OpenClaw Control UI，并在 Electron Main 中协调
Gateway、LongHub Core、Skill Worker、Agent Pack 与本机安全边界。

## 为什么存在

产品需要保留 OpenClaw 原生聊天和多 Agent 体验，同时把模型、Pack、企业工具和授权统一交给
龙枢后台与 Core 管理。Desktop 只做薄宿主和生命周期协调，不另造聊天面板，也不让 WebUI 直接
取得 Electron IPC 或上游 API Key。

## 核心职责

- 启动时先检查设备授权；未激活只显示独立授权码窗口，成功前不启动模型、Core、Gateway 或主 WebUI。
- 将设备 Token 保存在当前 Windows 用户的 Credential Manager；`device.json` 只保留指纹和设备 ID，
  旧明文 Token 必须在凭据写入并回读一致后才清除。
- 所有生产日志使用共享结构化 Logger；设备/Gateway/Bridge Token、API Key、授权码和用户内容在输出前
  递归脱敏，子进程错误文本也先清理再显示或记录。
- Desktop 脱敏日志写入龙枢专属 `userData/logs`，按 5 MiB 单文件、5 个文件轮转；启动时只清理
  固定命名且过期的更新下载和原子临时文件。龙枢受管状态超过 8 GiB 且无法安全释放时进入
  `LH-ST-001`，不自动删除 OpenClaw 会话、记忆、workspace、Pack、凭据或回滚证据。
- 启动时至少保留 256 MiB 可用磁盘空间，写入返回 `ENOSPC/EDQUOT` 时显示固定 `LH-ST-002`；Windows
  从休眠恢复后主动复检真实 `/chat`，失败时合并并发请求并受控重启 Gateway。
- 使用安装包内预置的独立 Update 公钥验证严格客户端更新元数据，持久化各渠道最高序列，并在执行
  安装前流式核对安装包大小与 SHA-256；暂停和灰度策略同样纳入签名，安装前会再次在线复验；
  不信任在线公钥接口自举。
- 升级前必须取得当前版本的签名安装器并验证摘要、Authenticode 主体与时间戳；本地只保留当前版和
  上一版可信库存。新版本连续三次启动失败或 180 秒未出现真实 WebUI 健康信号时，自动恢复安装前
  LongHub 状态并启动旧安装器；刚回滚的坏版本不会再次自动安装。
- Gateway 运行中退出后按指数退避自动恢复；只有真实 HTML `/chat` 健康后才回到原生界面并清零
  连续失败计数。配置错误和重启耗尽进入固定错误码安全页，不显示 URL、Token、本机路径或上游正文。
- 获取运行配置时最多进行三次指数退避；只有网络、429/5xx 瞬时故障耗尽后才使用同 Cloud、同设备、
  未过期且最长十分钟的严格缓存。401/403、协议或字段不兼容、过期和损坏缓存均安全失败。
- 固定产品错误页可一键导出 `longhub/diagnostic-export/v1` JSON；报告只含白名单状态，不收集日志、
  聊天、用户文件、设备 ID、服务 URL、Token、端口、PID 或本机路径，且不会自动上传。
- 已激活后启用严格匿名运行指标，只记录版本、启动耗时/Agent 数量桶、Gateway 枚举状态、更新结果和
  固定公开错误码。最多 32 项在内存中短暂合并，发送失败直接丢弃；不落本地队列、不重试，也不影响
  启动、聊天、更新或退出。请求体不含凭据、身份、聊天、文件、路径、URL、端口、PID 或异常。
- 使用独立 `userData/openclaw` 状态、配置、workspace 和动态回环端口托管锁定版 Gateway。
- 从云端取得唯一的 `longhub/longhub-default` 模型配置，客户端不允许选择真实模型。
- 验签安装 Agent Pack，维护稳定 Agent Registry，并编译 `main + 已启用 Profile`。
- 每 30 秒组合云端 catalog 与设备 entitlement，把客户端锁定认识、已授权但未安装的 Agent 放入
  原生 Selector；一次点击完成下载、验签、信任持久化、激活和专属会话进入。
- 使用 OpenClaw `config.patch + baseHash` 运行时启停 Agent，并回读 `agents.list`。
- 同步 entitlement；撤销时先关闭 Core 工具策略，再从原生 Selector 移除 Agent。
- 维护原生 Selector 允许列表，恢复目标 Agent 最近会话，并在活动执行结束或用户确认停止后切换。
- 注入版本化龙枢产品 UI：统一龙枢头像、中文状态、可读会话标题与普通用户导航；不改写聊天消息。
- 通过受限 Tool Bridge 将可信 agent/session/toolCall 上下文交给 Core。

本模块不负责真实模型路由、租户计费、企业技能业务逻辑或最终权限计算；这些分别属于 Cloud API、
Core 与 Skill Worker。

后续普通用户功能和 Skill 不恢复 OpenClaw 底层设置页，而是在 `/chat` 内使用受版本约束的产品薄入口；
文件、麦克风、截图和保存只允许单用途本机请求。开放矩阵与实施状态见
[普通用户功能开放策略](../../PRODUCT_FEATURE_POLICY.md) 和
[Skill 开放设计](../../SKILL_PLATFORM.md)；任务顺序以
[V2 执行计划](../../EXECUTION_PLAN_V2.md) 为准。

## 依赖关系

Desktop 依赖 `@longhub/core`、Pack Schema、HR 样例 Pack、OpenClaw Bridge、
`@longhub/openclaw-compat` 和锁定版
`openclaw@2026.7.1-2`。Electron Main 使用 Cloud API 获取设备凭据、模型配置、Pack 和 entitlement；
Control UI 只连接本机 Gateway。

## 开发与验证

当前 OpenClaw 要求 Node `>=22.22.3 <23`、`>=24.15.0 <25` 或 `>=25.9.0`。

```powershell
pnpm --filter longhub-desktop typecheck
pnpm --filter longhub-desktop test
pnpm --filter longhub-desktop build
pnpm --filter longhub-desktop start

# OpenClaw 升级后审查并重生成外置运行时白名单
pnpm --filter longhub-desktop runtime:manifest

# 明确生成未签名内部候选
pnpm --filter longhub-desktop dist:internal
pnpm --filter longhub-desktop verify:release:internal

# 正式发布：需先注入签名证书并审批品牌清单
$env:CSC_LINK = '<构建机上的 PFX 路径或 CI secret URL>'
$env:CSC_KEY_PASSWORD = '<仅存在于密钥存储的密码>'
$env:LONGHUB_EXPECTED_SIGNER_SUBJECT = '<证书 Subject 中应包含的组织名>'
pnpm --filter longhub-desktop dist
```

模块入口为 `src/main.ts`；可复用的 Registry、Composer、生命周期协调器和 Gateway RPC 客户端从
`src/index.ts` 导出。锁定版 Gateway + Electron 的 Selector E2E 覆盖最近会话、执行中停止和撤销
回退；隔离证据见 [LH-036-07 验收报告](../../docs/validation/LH-036-07-agent-selector-e2e.md)。
同一 userData 重启、Pack 升级/回滚、0.3.5 状态升级和双真实 Gateway 共存证据见
[LH-036-08 候选版验收报告](../../docs/validation/LH-036-08-candidate-continuity.md)。架构、安全边界和
变更记录见 [DESIGN.md](DESIGN.md)。全新 userData 的云端授权、一键安装、真实 Gateway 热激活和
真实 Electron 点击证据见
[LH-036-09 一键安装验收报告](../../docs/validation/LH-036-09-agent-provisioning-e2e.md)。
精确版本预检、真实 UI 合约和固定区域容差视觉回归见
[LH-037-01 兼容层验收报告](../../docs/validation/LH-037-01-openclaw-compat.md)。
龙枢品牌、中文化、会话标题和导航白名单证据见
[LH-037-02 产品 UI 验收报告](../../docs/validation/LH-037-02-product-ui.md)。
首次授权码核销、撤销阻断和真实 Electron 激活窗口证据见
[LH-038-01 设备激活验收报告](../../docs/validation/LH-038-01-device-activation.md)。
Windows 内部/正式构建分离、品牌审批和 Authenticode 验签见
[LH-040-01 发布门禁记录](../../docs/validation/LH-040-01-windows-signing.md)。
Windows Credential Manager、旧凭据事务迁移和失败恢复证据见
[LH-040-02 设备凭据迁移记录](../../docs/validation/LH-040-02-credential-manager.md)。
共享 Logger、Cloud 审计二次清理与敏感信息回归证据见
[LH-040-03 日志脱敏记录](../../docs/validation/LH-040-03-log-redaction.md)。
ASAR 封装、OpenClaw 外置依赖闭包和打包态 Core/Worker/Bridge/Gateway 证据见
[LH-040-04 ASAR 验收记录](../../docs/validation/LH-040-04-asar.md)。
客户端更新元数据签名、防回滚、历史公钥轮换和下载摘要验证见
[LH-040-05 更新签名验收记录](../../docs/validation/LH-040-05-update-signing.md)。
稳定渠道自动检查、原生确认、Authenticode 复验、停机快照和跨版本健康标记见
[LH-040-06 自动更新事务验收记录](../../docs/validation/LH-040-06-stable-auto-update.md)。
签名暂停、固定 cohort 灰度、策略 sequence 和安装前撤回复验见
[LH-040-07 灰度与暂停验收记录](../../docs/validation/LH-040-07-signed-rollout-pause.md)。
上一稳定版安装器库存、失败阈值、状态恢复和坏版本抑制见
[LH-040-08 自动回滚验收记录](../../docs/validation/LH-040-08-binary-auto-rollback.md)。
Gateway 运行中故障恢复、真实 `/chat` 健康门槛和固定错误码安全页见
[LH-040-09 运行时恢复验收记录](../../docs/validation/LH-040-09-runtime-recovery-error-pages.md)。
运行配置 schema、指数退避、设备绑定安全缓存和有效期拒绝证据见
[LH-040-10 运行配置韧性验收记录](../../docs/validation/LH-040-10-runtime-config-resilience.md)。
白名单诊断 schema、安全文件写入和真实 sandbox 错误页点击证据见
[LH-040-11 一键诊断导出验收记录](../../docs/validation/LH-040-11-diagnostic-export.md)。
日志轮转、白名单临时文件清理、8 GiB 状态硬上限和符号链接拒绝证据见
[LH-040-12 存储维护验收记录](../../docs/validation/LH-040-12-storage-maintenance.md)。
强退、断网、休眠恢复、系统重启、端口冲突和磁盘不足证据见
[LH-040-13 稳定性场景验收记录](../../docs/validation/LH-040-13-host-resilience.md)。
匿名契约、失败不阻断、鉴权限流和服务端小时聚合证据见
[LH-040-14 遥测边界验收记录](../../docs/validation/LH-040-14-client-telemetry.md)。
上一进程退出只由本地严格 `client-run-marker.json` 在下一次启动推导，不收集崩溃转储或堆栈；完整定义见
[LH-040-15 健康指标验收记录](../../docs/validation/LH-040-15-health-metrics-dashboard.md)。
