# LH-V2-005 受限产品入口骨架验收

> 状态：代码完成  
> 日期：2026-07-30  
> 部署状态：未部署

## 已完成

- agent.catalog、skill.catalog、memory.user_controls 分别控制“智能体 / 能力 / 我的”入口。
- OpenClaw 主页面只注入无 Node/IPC 的固定链接；策略未允许时不生成链接。
- Main 解析入口并再次判定；相似 scheme/host/path、参数、凭据和 confirmations 直达均拒绝。
- longhub-product://app 作为独立 standard/secure origin，只提供安装包内 HTML/CSS/JS/头像。
- 子窗口固定 contextIsolation、sandbox、无 Node、webSecurity 和禁止 mixed content。
- preload 只暴露 context/close；Main 绑定 sender、精确 URL、窗口、entry、action 和一次性 nonce。
- Feature Policy 刷新或紧急停用会更新入口并关闭已失去授权的窗口。
- ASAR 门禁要求三项产品资源和 CommonJS preload 存在，并拒绝同名 ESM preload。

## 自动化证据

| 门禁 | 结果 |
|---|---|
| Desktop typecheck/build | 通过 |
| 入口脚本专项 | 2 项通过 |
| 真实 Electron 子窗口 E2E | 1 项通过 |
| OpenClaw Compat | 9 项通过 |

真实 Electron 证据覆盖 960 × 720 视觉基线、独立 URL、中文标题/状态、bridge 只有 close/context、无
window.process/window.require、skills 策略拒绝、settings 直接导航保持原页、data origin 攻击窗口 IPC
拒绝。测试截图仅用于本地断言，未作为运行时依赖。

## 安全结论

产品入口只是 UI 容器，不成为授权来源。Feature Policy 负责入口与低风险离线边界，Cloud/Core 仍在
真实业务执行点复验。当前骨架不开放文件路径、shell、麦克风、截图、任意网络、任意 IPC 或远端 HTML。
后续每个业务动作必须新增单用途 channel/capability handle 和对应威胁测试。
