# longhub-platform

龙枢不是单个智能体，而是用于安装、运行、组合和运营多个领域智能体的平台。

## Windows 客户端界面

`apps/longhub-desktop` 启动内嵌 OpenClaw Gateway 后，主窗口直接加载该 Gateway
提供的原生 Control UI（优先使用 `http://127.0.0.1:18789/`，端口冲突时自动选择
空闲回环端口）。LongHub 不再在原生 WebUI 外额外套一层 React 工作台面板。

- Gateway 令牌仅通过 URL fragment 注入，进入 Control UI 的 `sessionStorage`，不会作为
  HTTP 查询参数发送。
- OpenClaw 页面不加载 LongHub preload，也不能直接访问本地 IPC 权限。
- `LONGHUB_OPENCLAW_WEBUI_URL` 可覆盖同源 WebUI 路径，适合后续使用自定义
  `gateway.controlUi.basePath`；为避免令牌泄露，不允许跨源覆盖。
- `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` 可连接已有 Gateway；未指定时
  客户端启动本机内嵌 Gateway。
- 正式客户端启动时自动注册/复用设备，从 Cloud API 获取唯一的
  `longhub/longhub-default` 配置并直达 `/chat`；上游 OpenAI 兼容地址、API Key 和真实
  模型 ID 由管理后台统一维护，客户端不提供模型或 Gateway 连接配置。
- 设备注册不等于产品授权。全新设备首次启动只显示独立授权码窗口；核销成功后才准备模型配置、
  Core、Gateway 和原生 `/chat`。以后启动直接进入，授权码被撤销或到期后服务端立即拒绝模型与
  受保护产品 API，下次启动重新显示激活页。
- 设备 Token 只保存到当前 Windows 用户的 Credential Manager；旧 `device.json` 明文凭据在写入并
  回读确认后自动清除，文件只保留非敏感设备元数据。
- 内嵌实例固定使用 `userData/openclaw/workspace`，预置“龙枢助手”身份；不会读取或导入
  用户原有 `~/.openclaw/workspace` 中的身份、记忆、技能或提示文件。
- 客户端启动时会从 PackInstaller 当前 active 指针重新校验 Pack，注册已启用 Profile，安全落盘
  独立 workspace/agentDir/session，并把 `main + 已安装智能体` 写入真实 `agents.list`；已安装的
  HR Pack 因此会直接出现在 OpenClaw 原生 Agent Selector。
- Pack 可在 Gateway 运行中一键启用/停用：Desktop 使用锁定版 OpenClaw
  `config.patch + baseHash` 原子替换 `agents.list` 并回读确认。entitlement 默认每 30 秒同步；确认
  撤销后先移除 Core 执行策略，再移除 Selector。workspace、历史会话和稳定 agentId 不会被删除。
- 已授权但尚未安装的 HR Pack 会直接以“HR 助理（点击安装）”出现在原生 Selector；一次点击由
  Desktop 完成下载、制品元数据核对、Ed25519 验签、公钥持久化、激活和 Gateway 热更新，成功后
  进入 HR 专属会话。云端目录只能启用客户端锁定认识的 Pack，不能自行注入 profileId 或 agentId。
- Selector 薄适配层只接受 Desktop 下发的启用 Agent 允许列表；上游未渲染控件时复用其原生样式和
  `selectAgent()` 会话路由补出入口。切换会恢复最近会话，执行中先确认停止；撤销后显式回退
  `agent:main:main`，历史 HR 会话不会因此重新变为可选 Agent。
- 产品化薄层把窗口、侧边栏、欢迎页和状态统一为“龙枢”中文体验，隐藏管理导航和基础设施词汇，
  将默认会话显示为“龙枢助手会话”并移除悬停标题中的内部 session key；该层只处理版本契约登记的
  UI chrome，不改写聊天消息，也不增加 preload/IPC 权限。
- Gateway 运行中异常会进入限频自动恢复状态；客户端只有在真实 `/chat` 返回 HTML 后才重新显示
  原生界面。配置错误、连续恢复失败、断网、凭据失效、后台未配置、限流和上游故障使用固定短错误码，
  页面不拼接原始异常、服务地址、Token 或本机路径。
- 运行配置请求最多执行三次指数退避；只有网络、429 或 5xx 瞬时错误耗尽后，才允许读取与当前
  Cloud origin、设备 ID 绑定且最长十分钟的严格缓存。401/403、协议不兼容、配置过期或校验失败
  绝不回退缓存；缓存不含设备 Token、上游 API Key、真实模型 ID 或真实上游地址，也不构成授权。
- 产品错误页提供“一键导出诊断信息”，由 Main 打开原生保存对话框。JSON 只包含固定错误码、版本、
  Gateway/运行配置/更新阶段和 Agent 数量，不读取日志、聊天、用户文件、Credential Manager 或环境变量，
  也不包含设备 ID、服务 URL、端口、PID 或本机路径。
- Desktop 脱敏 JSONL 按 5×5 MiB 固定轮转，只对白名单内过期的更新下载和临时制品执行清理；
  龙枢受管状态超过 8 GiB 后显示 `LH-ST-001`，不会自动删除会话、记忆、Pack 或回滚证据，用户原有
  `~/.openclaw` 也不在扫描范围。
- Windows 休眠恢复后主动复检真实 `/chat` 并按需受控重启 Gateway；磁盘剩余空间低于 256 MiB 或
  关键写入返回 `ENOSPC/EDQUOT` 时显示 `LH-ST-002`，不误导用户修改模型配置。
- 匿名运行指标使用严格 `longhub/client-telemetry/v1`：只上传版本、粗粒度启动/Agent 数量桶、Gateway
  状态、更新结果和固定公开错误码。客户端仅保留有界内存批次且失败即丢弃；Cloud 只保存小时聚合，
  不保存设备/用户/租户标识、原始事件、聊天、文件、路径、URL、端口、PID 或异常文本。
- 管理后台以近 24 小时匿名聚合展示异常退出、模型成功率/TTFB、升级健康、固定错误码和版本分布；
  Desktop 运行标记与模型代理指标都失败不阻断，后台没有逐设备遥测入口。
- 后台运行策略按设备、套餐、租户、全局分层，支持 ETag/有效期、客户端兼容范围、紧急停用、助手文案、
  备用模型与重试/熔断；模型请求执行速率、日月额度、并发和 Token/成本计量，用户仍不能选模型。
- 内置 LongHub Tool Bridge 从 OpenClaw 运行时取得可信 agent/session/toolCall，经随机令牌保护的
  本机 RPC 进入 Core；模型参数不能提交身份、权限、确认或预算。Core 执行前在线复验云端授权和
  Pack 版本，计算 Profile/Pack/租户/设备/预算交集。当前 HR Agent 已开放只读简历初筛工具。

开发运行：

```powershell
pnpm --filter longhub-desktop build
pnpm --filter longhub-desktop start
```

Windows 发布分为两条显式通道：`dist:internal` 允许生成未签名内部候选，`dist` 只生成正式发布物，
并强制校验已审批品牌资产、安装包/主程序 Authenticode 主体和可信时间戳。证书与密码只通过构建机
或 CI 密钥注入，不进入仓库。

桌面端内嵌的 OpenClaw 2026.7.1-2 要求 Node `>=22.22.3 <23`、`>=24.15.0 <25`
或 `>=25.9.0`；执行 `predist` 的 Node 会被复制为安装包内运行时，因此打包机也必须满足
这个区间。

项目级文档：

- [平台总体设计](DESIGN.md)
- [V2 后续开发执行计划（当前唯一进度源）](EXECUTION_PLAN_V2.md)
- [历史路线与完成记录](ROADMAP.md)
- [0.3.6 候选版重启、升级、回滚与共存验收](docs/validation/LH-036-08-candidate-continuity.md)
- [已授权未安装 Agent 一键安装验收](docs/validation/LH-036-09-agent-provisioning-e2e.md)
- [一键智能体切换设计](AGENT_PLATFORM.md)
- [普通用户功能开放策略](PRODUCT_FEATURE_POLICY.md)
- [Skill 开放与生态设计](SKILL_PLATFORM.md)
- [Agent Profile V1 契约](contracts/agent-profile/agent-profile-v1.md)
- [桌面端详细设计](apps/longhub-desktop/DESIGN.md)
- [云端模型网关设计](apps/longhub-cloud-api/DESIGN.md)
- [OpenClaw Tool Bridge 设计](packages/longhub-openclaw-bridge/DESIGN.md)
- [OpenClaw 版本化兼容契约](packages/longhub-openclaw-compat/DESIGN.md)
- [LH-037-01 OpenClaw 兼容层验收](docs/validation/LH-037-01-openclaw-compat.md)
- [LH-037-02 龙枢 UI 产品化验收](docs/validation/LH-037-02-product-ui.md)
- [LH-038-01 首次授权码激活验收](docs/validation/LH-038-01-device-activation.md)
- [LH-040-01 Windows 代码签名与品牌门禁](docs/validation/LH-040-01-windows-signing.md)
- [LH-040-02 Windows Credential Manager 迁移](docs/validation/LH-040-02-credential-manager.md)
- [LH-040-09 Gateway 运行时恢复与安全错误页](docs/validation/LH-040-09-runtime-recovery-error-pages.md)
- [LH-040-10 运行配置退避、安全缓存与有效期](docs/validation/LH-040-10-runtime-config-resilience.md)
- [LH-040-11 一键脱敏诊断导出](docs/validation/LH-040-11-diagnostic-export.md)
- [LH-040-12 日志轮转与受管状态维护](docs/validation/LH-040-12-storage-maintenance.md)
- [LH-040-13 Windows 主机中断与资源不足稳定性](docs/validation/LH-040-13-host-resilience.md)
- [LH-040-14 最小匿名运行指标与遥测边界](docs/validation/LH-040-14-client-telemetry.md)
- [LH-040-15 匿名健康指标与管理看板](docs/validation/LH-040-15-health-metrics-dashboard.md)
- [LH-050 后台统一运营](docs/validation/LH-050-runtime-model-device-operations.md)
