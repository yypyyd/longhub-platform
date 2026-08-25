# LH-V2-050 LongHub Desktop 0.8.3 同壳智能体验收

> 2026-08-01：本文只保留 0.8.3 历史证据。用户复验确认自制同壳抽屉仍不属于 OpenClaw 官方原生页面；
> 后续版本已改为恢复官方侧边栏和经过审查的原生路由，不得再把本文作为当前导航的验收依据。

> 状态：通过，0.8.3 已安装复验并发布到 production stable 100%
> 日期：2026-07-31

## 修正目标

0.8.2 只证明三入口可见且能在 Lit 重渲染后恢复，没有完成 OpenClaw 原生产品体验。0.8.3 必须消除
横排红字入口、把“智能体”从无代码工作台纠正为真实管理页，并让单 Agent 用户也能看到当前位置。

## 实现结果

- 三入口改为 OpenClaw 同设计语言的纵向导航，具备 hover、focus、选中态和重渲染恢复。
- 原生 Selector 单 Agent 常显；Main 只能通过页面内既有策略调用锁定版 `selectAgent()`。
- 新增 AgentManagementService，统一当前、已启用、已停用和可安装快照；切换、安装、启用、停用只接受
  当前可信快照中的 Agent/Pack，实际生命周期继续执行 entitlement、签名、Gateway 回读和补偿事务。
- 智能体抽屉先显示管理列表；Content Skill、Workflow、无代码 Agent 和摘要转交移动到“创建与编排”。
- 产品视图改为主窗口右侧同壳抽屉；它仍是独立 origin、sandbox、无 Node 的 webContents，并通过
  逐窗口、逐动作、一次性 nonce IPC 完成本机读写。主 OpenClaw 页面没有增加 preload。
- 抽屉跟随主窗口移动和缩放；策略撤销仍立即关闭已失去授权的视图。

## 已执行证据

- Desktop TypeScript Main/Renderer 类型检查通过。
- Desktop 全量 61 个测试文件、282 项全部通过。
- Product Extension 真实 Electron E2E 通过：真实切换到财务助理，受限路由、攻击窗口、无 Node、
  nonce、确认中心以及“切换入口只保留一个普通抽屉”均未回归。
- 锁定版 OpenClaw Selector E2E 隔离运行通过：最近会话恢复、运行中先停止、撤销回退 main、三入口
  重渲染恢复和单 Agent 常显通过。
- 全仓并发回归 493 项通过、8 项按环境跳过；唯一失败为上述 Selector E2E 在 180 秒全仓并发门槛超时，
  同一测试隔离运行 159 秒通过，因此门槛调整为 240 秒并要求再次全量复验。
- Cloud API 20 个测试文件、108 项通过，PostgreSQL 环境项 8 项按约定跳过；Admin 6 项通过，
  Cloud API、Admin、Portal 均重新构建成功。

## 安全边界

- Feature Policy 只控制可见与入口开放，不能替代 entitlement、Core、Gateway 或业务 API 授权。
- 主 WebUI 仍为 `sandbox=true`、`contextIsolation=true`、`nodeIntegration=false` 且无 LongHub preload。
- Agent 管理 action 严格限制为 select/install/enable/disable，并校验当前快照成员；任意 ID、额外字段、
  nonce 重放、跨窗口或跨 origin 调用均拒绝。
- main 为内置智能体，不能停用或被 Pack 覆盖；当前智能体被撤销/停用时回退 main。

## 0.8.3 发布与安装态

- 安装包：`apps/longhub-desktop/release/LongHub-Setup-0.8.3.exe`
- 大小：`163167902` bytes
- SHA-256：`5f6f7284080980d86e57de74d4336e5a4c3fc9dd92c61dc1356ed24bc59ffad9`
- Node：`v25.9.0`，OpenJS Authenticode 签名有效。
- Core、Worker、Bridge、Gateway 四项打包后 smoke 全部通过，OpenClaw 为 `2026.7.1-2 (0790d9f)`。
- 本机静默覆盖安装成功，主程序 `FileVersion=0.8.3`、`ProductVersion=0.8.3.0`。
- 安装态截图：`apps/longhub-desktop/release/installed-final-0.8.3-window.png`、
  `apps/longhub-desktop/release/installed-final-0.8.3-agents.png`。
- 安装态 DOM/CDP 复验确认：纵向“智能体 / 能力 / 我的”、单 Agent Selector 常显、智能体管理抽屉完整、
  无 `OpenClaw` 品牌字样、抽屉无 Node，入口切换后仅保留一个普通产品视图。

## 生产验收

- stable 清单 sequence `12`，版本 `0.8.3`，状态 `active`，`basis_points=10000`。
- 公网健康、Portal、Admin 均为 200；公网安装包 Range 下载为 206，服务端文件大小和 SHA-256 与本地一致。
- 运行容器内 Cloud API、Executor、Feature Policy 共 72 个编译文件与本地逐字节一致；Admin、Portal
  共 8 个发布文件与本地逐字节一致，因此未对相同运行镜像做无意义重启。
- PostgreSQL 保留 16 台设备、2 条授权；Cloud API、Executor、Web、PostgreSQL 均运行，重启次数为 0。
- 临时数据库/Web 快照、上传/构建暂存目录、回滚镜像标签、失败构建产生的 507 MB dangling 镜像均已删除；
  备份容器和备份镜像为 0。

## 质量关卡

- CCG 变更校验：通过，README/DESIGN 同步。
- CCG 质量校验：通过，0 错误；保留 `main.ts`、`product-extension-window.ts`、`skill-registry.ts`
  三个文件长度提示，未发现阻断问题。
- CCG 安全校验：通过，Critical/High/Medium/Low 均为 0。

## 已知发布约束

- 当前为内部候选：安装器和主程序尚无商业 Authenticode 证书，`brandStatus=temporary`、
  `updateTrustStatus=pending`、`skillTrustStatus=pending`；正式外部分发仍需配置生产证书与信任策略。
