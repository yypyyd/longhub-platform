# LongHub 历史路线归档

> 文档状态：只读历史资料，不是当前排期，不作为上线或部署说明
>
> 当前产品基线和下一步只看 [EXECUTION_PLAN_V2.md](EXECUTION_PLAN_V2.md)

LongHub 尚未正式上线。项目早期曾探索 Electron、内嵌 OpenClaw 页面、私有运行时、Agent/HR 套装和本地
授权/计费；这些方向已经在 2026-08-09/11 的 clean-launch 决策中废弃。保留本文件是为了让测试、提交和
审计记录仍然有出处，不代表需要兼容旧客户端或旧设备。生产从空 schema 创建，明确不迁移历史数据；
历史 SQL 不会由 clean-launch runner 执行。

## 1. 当前有效结论（仅作索引）

现在只执行以下产品边界：

- LongHub Manager 免费，帮助小白用户按官方方式安装和管理用户原生 OpenClaw。
- LongHub 只提供自己的管家页，不嵌入或仿制 OpenClaw Control UI。
- 用户模型、Provider、Channels、Agent、插件、MCP、第三方 Skill 和 workspace 不受 LongHub 订阅限制。
- 商业收费只围绕 LongHub Cloud Skill；客户端只安装签名薄适配器/固定桥接插件，私有实现留在云端。
- Manager 注册设备并把长期凭据留在系统安全存储，只向用户展示短时一次性配对码；Portal 原子消费完成绑定。
- 新环境从空 schema 直接部署；不创建旧表，不设计旧设备激活、历史订单、数据迁移或回滚到旧产品的操作。

完整设计见 [DESIGN.md](DESIGN.md) 和 [PRODUCT_FEATURE_POLICY.md](PRODUCT_FEATURE_POLICY.md)。

## 2. 已归档的研究与实现（不表示首发可用）

下表只记录曾经完成或验证过的技术切片，均不能单独作为新产品功能或上线证据：

| 时间 | 历史切片 | 现在的结论 |
| --- | --- | --- |
| 2026-07-29 | Electron UI 产品化、OpenClaw 版本兼容层、桌面更新/日志/诊断 | 仅供回归资料；新 Manager 自有页面重新实现 |
| 2026-07-29 | Agent Profile、Selector、Pack 签名和生命周期 | 仅供安全/供应链测试；不作为销售或授权模型 |
| 2026-07-30 | Feature Policy V2、确认中心、匿名遥测、CI/Store 合同 | 可复用契约/安全原则；策略不得限制本地 OpenClaw |
| 2026-07-31 | 文件、知识、会话和无代码能力候选 | 暂不进入首发管家；按新需求另行评估 |
| 2026-08-09 | Manager 原生运行时、Cloud Skill 薄适配器和订阅模型 | 已提升为当前主线，见执行计划 |
| 2026-08-10 | Ubuntu VMware 原生 Gateway/插件/Bridge fixture 闭环 | 只证明本地集成契约；仍需 Windows/生产 E2E |

## 3. 历史记录阅读规则

历史验证记录、早期 Electron 客户端目录和旧包的 README/DESIGN 可能包含已废弃的产品假设。阅读时：

1. 只把它们当作当时的测试输入、风险证据或代码背景；
2. 不按其中的安装、授权、支付、模型配置或兼容步骤操作；
3. 新实现遇到冲突时，以 `DESIGN.md`、`PRODUCT_FEATURE_POLICY.md`、`SKILL_PLATFORM.md` 和
   `EXECUTION_PLAN_V2.md` 为准。

## 4. 已明确废弃的路线

- 内嵌 OpenClaw Control UI、同壳导航或 DOM 注入产品化。
- 将 OpenClaw/Node 复制到 LongHub 独立目录，或为 LongHub 维护第二个 Gateway。
- 用统一后台模型、Provider 白名单或 Feature Policy 锁定本地能力。
- 以授权码、HR/Agent Pack、旧商品、余额/钱包或模拟支付作为首发销售流程。
- 为既有设备保留迁移、激活码续期或兼容回滚。

这些项目若未来需要重新讨论，必须创建新的产品决策并更新当前执行计划；不得从历史代码路径隐式恢复。
