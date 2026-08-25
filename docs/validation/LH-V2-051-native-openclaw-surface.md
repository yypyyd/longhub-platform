# LH-V2-051 OpenClaw 官方原生页面开放验收

> 状态：0.8.4 内部候选已构建并发布 production stable 100%；未在本机覆盖安装
> 日期：2026-08-01

## 目标

停止在 OpenClaw 主界面注入龙枢自制的“智能体 / 能力 / 我的”三入口，恢复锁定版 OpenClaw
`2026.7.1-2` 的官方侧栏，并只开放经过逐页审查的普通用户页面。龙枢继续负责身份、模型、授权、
Feature Policy、私有 Skill 和高风险执行边界。

## 原生页面矩阵

普通用户可进入以下官方原生路由：

- `/chat`
- `/activity`
- `/agents`
- `/sessions`
- `/usage`
- `/tasks`
- `/skills`

主窗口采用同源、HTTP(S)、精确路径白名单；未登记路径默认回退 `/chat`。`/overview`、`/settings/*`、
`/config`、`/channels`、`/cron`、`/nodes`、`/instances`、`/debug`、`/logs`、`/skills/workshop`、
`/workboard`、`/worktrees`、`/dreaming`、`/dreams`、`/plugin` 等控制面或未审查页面继续禁止。

## 页面内限制

- Agents：允许 Overview、Tools、Skills、Channels 只读查看；初次进入从上游默认 Files 强制回退
  Overview；隐藏 Files、Cron、模型修改、设默认 Agent、Tool/Skill 开关与配置动作。
- Skills：允许查看已安装目录、详情和安全报告；隐藏 ClawHub 搜索/安装、启停、依赖安装和 API Key 编辑。
- 模型选择、搜索与管理入口继续隐藏；自制 `[data-longhub-extension-entry]` 数量必须为 0。
- UI 隐藏只用于收敛产品面，不替代 Cloud entitlement、Feature Policy、Core、Gateway 和业务 API 授权。

## 私有 Skill 边界

龙枢自有、需要保护实现的 Skill 默认采用 `cloudRef`：客户端只保存经签名的展示元数据、输入输出 Schema、
`serviceId + apiVersion`、权限和费用声明，不保存服务 URL、实现代码、完整系统提示词或风控阈值。

本次没有删除 Desktop 中现存的 `jd-draft`、`resume-screen`、`offer-letter` builtin，也不能据此宣称它们
已经全部迁移到 Cloud Executor。当前 `/v1/tasks` 与 Executor 仍是原型链路；正式迁移前必须补齐任务 owner
隔离、设备/租户/Agent/Skill 授权复验、服务端预算与并发复验、Cloud API → Executor 短期单任务凭据，以及
生产 CORS/网络隔离。未达到这些条件前，不得用“已云端保护”作为发布口径。

## 已执行证据

- `pnpm --filter @longhub/openclaw-compat build`：通过。
- `pnpm --filter @longhub/openclaw-compat test`：10/10 通过。
- `pnpm --filter longhub-desktop typecheck`：通过。
- Desktop 原生路由与页面策略测试：8/8 通过。
- 锁定版 Gateway + 真实 Electron Selector E2E：通过；官方侧栏和六个非 Chat 原生入口可见，Agents
  初始面板为 Overview，Agents/Skills 高风险控件为 0，自制三入口为 0。
- `pnpm --filter longhub-desktop test`：61 个测试文件、283 项全部通过。
- `pnpm --filter longhub-desktop build`：通过。

兼容契约摘要：`EDC310A59F7B4C029C77A8FD5B98F8F9AFC0A433E04C6192E46CC1DC3415C88F`。

## 0.8.4 构建与生产发布

部署日期：2026-08-05（Asia/Shanghai）。此前 0.8.3 自制同壳方案只作为历史记录，不再作为当前原生
页面方案的发布证据。

- 安装包：`apps/longhub-desktop/release/LongHub-Setup-0.8.4.exe`
- 大小：`163168719` bytes
- SHA-256：`819d14d829ad0e876502f48aac2e7cdca28bc0e6558e488e222d47a17a1f974e`
- 内置 Node：`v25.9.0`，OpenJS Authenticode 签名与可信时间戳有效。
- Core、Worker、Bridge、Gateway 制品级 smoke 全部通过；OpenClaw 为 `2026.7.1-2 (0790d9f)`。
- 安装器和主程序仍为 `NotSigned`，品牌为 `temporary`，Update/Skill 信任清单为 `pending`；因此是内部
  候选，不是具备商业 Authenticode 与正式信任审批的外部发行版。
- Cloud 上传后先保持 `paused:0`，服务端生成 sequence `13` 的签名记录；公网精确版本元数据的 Ed25519
  签名、Range 206、大小和摘要通过后，切换为 sequence `14`、`active:10000`。
- 公网完整流式下载 `163168719` 字节，SHA-256 与本地安装包逐字节摘要一致；Portal 运行时资源继续读取
  `/v1/client-releases/latest` 和 `url_path`，Cloud 健康、Portal、Admin 均为 HTTP 200。
- Cloud API、Executor、PostgreSQL、Web 四个容器均为 running、重启次数 0；数据库保留 16 台设备和
  2 条 entitlement。
- 上传暂存目录已删除；备份容器和备份镜像均为 0。保留 0.8.3 正式发布记录和安装包用于可信回滚。

本轮没有在当前 Windows 主机覆盖安装 0.8.4，因此“本机安装态 UI”不作为本记录的已完成证据。
