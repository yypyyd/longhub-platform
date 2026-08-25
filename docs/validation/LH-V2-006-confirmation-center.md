# LH-V2-006 Confirmation Center V1 验收

> 状态：代码完成  
> 日期：2026-07-30  
> 部署状态：未部署

## 已完成

- Core 确认请求新增可信 `skillId` 与结构化展示载荷；动作、对象、接收方、数据范围和费用由受信
  descriptor 结合已绑定输入计算，不接受模型或 Skill 提交运行时确认文案。
- 确认 binding digest 覆盖 Agent、Profile 版本、Skill、会话、ToolCall、权限、输入与展示载荷；记录
  五分钟过期、一次性消费，拒绝、过期、策略纪元变化、参数变化和跨 Agent 重放均失败。
- 新增真实写工具 `longhub_offer_letter`，固定映射 `longhub.skill.offer-letter` 与
  `connector:hr-api:write`；输入只允许候选人、职位、月薪和入职日期四个字段，未知授权字段被拒绝。
- 写 grant 只有在 `skill.catalog` 策略在线允许时进入 Bridge；离线缓存不能开启写权限。
- Desktop 以可信 `toolCallId` 等待确认，批准后只重试完全相同的原始 Bridge 请求，Core 消费批准记录
  后才执行 Worker；拒绝、关闭、超时、策略撤销或窗口失败均返回 `BRIDGE_FORBIDDEN`。
- confirmations 使用独立 sandbox 子窗口。preload 只暴露 confirmation/read、approve、deny、close 四个
  单用途方法；Main 逐 sender、URL、窗口、action 与 nonce 校验，一次只允许一个确认窗口。
- UI 通过 `textContent` 展示目标 Agent、Skill、动作、对象、接收方、数据范围、权限、费用和倒计时，
  不解释 HTML，也不把展示内容或工具输入写入日志。

## 自动化证据

| 门禁 | 结果 |
|---|---|
| Core 确认授权 | 4 项通过 |
| OpenClaw Bridge | 5 项通过 |
| HR Suite | 9 项通过 |
| OpenClaw Compat | 9 项通过 |
| Desktop Tool Bridge | 7 项通过 |
| Agent Composer + Tool Bridge + 真实 Electron 专项 | 3 文件、16 项通过 |
| Desktop typecheck/build | 通过 |
| Desktop 全量测试 | 47 文件、237 项通过 |

真实 Electron 证据覆盖 960 × 720 确认窗口、无 `window.process`/`window.require`、只存在四个确认方法、
可信展示字段、批准回调、关闭即拒绝，以及攻击窗口 IPC 拒绝。授权测试覆盖展示与输入绑定、拒绝、过期、
一次性消费、策略纪元变化和跨 Agent 重放。

## 安全结论

确认界面不是权限来源：它只能响应 Core 生成的确认 ID，真正执行仍由 Core 在同一绑定请求上重新检查
Profile、Pack、entitlement、Feature Policy、权限和预算。任何无法显示或无法在线确认策略的路径都
fail closed；批准本身不会直接调用企业连接器。

## 仍需后续任务验证

006 已完成本地代码与真实 Electron 门禁，但尚未部署。049 已把“策略刷新 → 确认一次”纳入冒烟、安全
和全量分级，007 再执行候选发布门禁。本机 pnpm 使用的 Node 24.14.0 低于 Desktop 声明的 24.15.0；
正式发布与安装包验证必须使用项目兼容版本。
