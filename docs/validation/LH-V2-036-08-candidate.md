# LH-V2-036 LongHub Desktop 0.8.2 内部候选复验

> 状态：产品体验退回（隔离、策略与入口持续性通过；原生化和智能体管理未通过）
> 日期：2026-07-31

## 0.8.0 与 0.8.1 退回原因

0.8.0 虽通过代码、Electron E2E 和发布 smoke，但在已安装程序中发现三项用户可见问题：

1. 主窗口仍显示 Electron 英文菜单栏。
2. 欢迎区“龙枢助手”头像破图。
3. “智能体 / 能力 / 我的”入口没有出现。

0.8.1 修复了菜单和头像，同时补齐客户端版本随 Feature Policy 请求回传；生产当前 QA 设备的
`agent.catalog`、`skill.catalog`、`memory.user_controls` 三条设备级策略随后均已启用。策略缓存确实包含
三条 enabled 项，但真实窗口的入口仍会消失。

最终根因为入口脚本只执行一次：0.8.1 隔离 E2E 在页面稳定后注入，未覆盖真实 OpenClaw 后续 Lit
重渲染；上游替换侧边栏 DOM 时会一并删除龙枢入口。0.8.2 改为 MutationObserver 驱动的持续协调器，
入口被删除或挂载点被替换后会自动恢复，策略变化时仍按 fail-closed 精确增删。

## 0.8.2 制品

| 项目 | 值 |
|---|---|
| 安装包 | `apps/longhub-desktop/release/LongHub-Setup-0.8.2.exe` |
| 大小 | 163,163,342 bytes |
| SHA-256 | `6fbf7a36a15836ae43fd22e0943e6805b1a5119927071735763061895cf05ed2` |
| 内置 Node | v25.9.0，OpenJS 有效签名与可信时间戳 |
| OpenClaw | 2026.7.1-2 (`0790d9f`) |
| 生产通道 | stable 100%，sequence 10 |

## 门禁

- Desktop typecheck 通过；Desktop 60 文件、279 项测试通过。
- OpenClaw 兼容契约 10 项通过；真实 Selector E2E 会主动删除入口并断言三项自动恢复。
- Desktop 安全扫描无发现；发布核验的 Core、Worker、Bridge、Gateway smoke 全通过。
- Cloud API 已部署客户端版本回传：设备 Bearer 鉴权后只原子更新该设备的 `app_version`，不能自报权限。

## 真实安装态与生产结果

- 0.8.2 静默安装成功；本机主程序 FileVersion 为 0.8.2。
- 当前 QA 设备 `dev-b00a3605-0599-4ea1-b7db-b43cb3906bc4` 状态 active，Cloud 记录版本为 0.8.2。
- 生产 Feature Policy 返回 200，三条设备级策略均为 enabled，最低 Desktop 版本为 0.8.1。
- `/v1/catalog/skills` 使用当前设备凭据返回 200，不再返回 `FEATURE_DISABLED`；当前目录发布数为 0。
- 真实安装窗口截图 `apps/longhub-desktop/release/installed-0.8.2-window.png` 可见“智能体 / 能力 / 我的”；
  0.8.1 对照截图 `apps/longhub-desktop/release/installed-0.8.1-window.png` 中没有三项入口。

这里的“三项放开”是三个产品功能入口，不是三个用户。入口可见性也不是最终执行授权：入口内各子能力
仍分别执行 Feature Policy、entitlement、Core 授权和用户确认。

## 2026-07-31 产品验收更正

真实用户复验发现 0.8.2 的三项入口为横排红字，打开后进入与 OpenClaw 视觉和导航模型不同的独立页面；
其中“智能体”实际展示无代码工作台，且单 Agent 条件下 Selector 被实现主动隐藏，因此用户既看不到
当前智能体管理位置，也无法验证切换流程。上述结果说明“入口可见”不能等价于“原生智能体体验完成”。

0.8.2 保留 stable 只用于说明已部署事实，不再作为 LH-V2-005/036 的最终产品验收证据。修正进入
LH-V2-050 / Desktop 0.8.3，验收必须包含单 Agent 仍显示、双 Agent 真实切换、安装/启停、运行中停止确认、
策略撤销、重渲染恢复以及真实安装态视觉截图。

## 0.8.3 收口结果

上述产品体验缺口已由 LH-V2-050 / Desktop 0.8.3 关闭：纵向同壳导航、单 Agent Selector 常显、真实
Agent 管理和“创建与编排”均通过真实 Electron 与安装态复验。0.8.3 已发布 production stable 100%，
公网安装包摘要与本地候选一致；最终证据见 `docs/validation/LH-V2-050-083-native-shell.md`。

因此 LH-V2-036 的 0.8 总门禁以 0.8.3 累计候选完成；本文件顶部仍保留“0.8.2 产品体验退回”状态，
用于准确记录 0.8.2 本身不能作为最终验收证据。

## 发布限制

品牌清单仍为 `temporary`，Update 与 Skill 信任清单仍为 `pending`；安装包和主程序均为 `NotSigned`。
因此该制品只允许内部候选验证。Authenticode 证书、正式品牌审批、生产 KMS、独立渗透测试、法务批准
和生产灰度仍属于 0.9/1.0 外部门禁，不能由本地测试替代。
