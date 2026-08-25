# LongHub Manager 架构基线

> 状态：新客户端重写基线
> 适用范围：Windows 首发，后续扩展 macOS/Linux
> 更新日期：2026-08-09

## 目标

LongHub Manager 是免费的 OpenClaw 安装、配置和运行管家。它不把 OpenClaw 运行时复制到自己的
私有目录，也不嵌入 OpenClaw Control UI；用户看到的是 LongHub 自己的管理页面，OpenClaw 继续在
用户系统的原生安装位置和原生工作区运行。

LongHub 的收费资产是云端 Skill。客户端只安装一个经过签名的薄适配器并转发调用，Skill 的实现、
系统提示词、业务规则、内部模型路由、连接器凭据和风控参数始终留在云端。

本地适配器属于用户电脑上的公开制品：用户可以查看、备份、删除或修改它。验签、版本绑定和服务端
执行门禁保证“修改本地文件”不会变成“修改云端实现或获得额外授权”；不能把本地文件物理防篡改当作
商业承诺。

## 运行拓扑

```text
用户浏览器
    │ localhost + 一次性管理令牌
    ▼
LongHub Manager（Go 服务/托盘进程）
    ├─ Runtime Manager：检测/安装/更新原生 Node + OpenClaw
    ├─ Gateway Manager：CLI/RPC、进程、端口、健康和备份
    ├─ Config Manager：严格 Schema、原子写入、回滚
    ├─ Skill Manager：签名适配器、绑定、升级、撤销
    ├─ Cloud Bridge：账号、订阅、云端 Skill 调用（执行专用凭据）
    └─ React 管家页面
          │
          ├─ 本机 OpenClaw Gateway / CLI
          │    └─ 原生 OpenClaw 通用 Tool Plugin
          └─ HTTPS LongHub Cloud API
                    └─ 私网 Cloud Skill Executor
```

管理页面令牌与 OpenClaw 执行令牌是两套凭据。后者只允许固定的 Cloud Skill 路由，按安装/Gateway
绑定、可轮换、可撤销；外部 Gateway 通过一次性 enrollment 注册，不把管理页面 Bearer 写入 OpenClaw
配置或环境变量。Manager 不默认假设外部 Gateway 由自己启动，也不因此强杀或接管其进程。

当前 v1 的具体本机流程是：管理页面用 Bearer 调用
`POST /api/v1/cloud-skill/enrollments` 生成短时一次性 code；外部通用插件将 code 发送到
`POST /api/v1/cloud-skill/enroll` 兑换执行令牌；之后只携带该令牌访问
`POST /api/v1/cloud-skill/execute`。Manager Credential Manager 只保存执行令牌摘要对应的秘密值，
`DELETE /api/v1/cloud-skill/execution-credential` 先撤销持久化值，再使内存令牌失效。首版限制为一个活动
Gateway enrollment，重新兑换会原子轮换旧令牌。

## 原生运行时规则

1. LongHub 首发只支持 Windows；运行时版本由受信任的 LongHub manifest 锁定。
2. 当前 OpenClaw 没有官方 Windows 安装器资产，首版使用官方 npm 包的原生全局安装流程；不把包
   复制进 LongHub 目录，也不使用未经审核的镜像。
3. 安装前检查 Node 兼容区间、管理员权限、PATH、磁盘空间和当前原生 OpenClaw 状态。
4. 首发按全新环境初始化：Manager 只使用当前上游 `.openclaw` 状态目录，不读取或转换 `.clawdbot` 等
   历史目录，也不导入旧设备凭据、订单或会话。若检测到非目标版本，只显示诊断和官方安装计划，由用户
   明确确认后在原生位置安装/更新；不提供旧设备或旧数据迁移路径。
5. 更新前创建配置/工作区备份，更新失败恢复原版本和原配置。LongHub 卸载不删除用户数据。
6. LongHub 只调用公开 CLI、公开 Gateway RPC 或严格版本适配器；禁止直接依赖 OpenClaw 私有数据库格式。

## 管家页面边界

LongHub 不加载 OpenClaw HTML、React bundle 或 Control UI。所有页面由 LongHub 自己提供，首版包含：

- 安装向导和运行状态。
- Gateway、Provider、Model、Channels、Agents、Sessions、Skills、Plugins、Logs、Updates。
- LongHub 账号、订阅、云端 Skill Catalog 和调用历史。

高级操作仍然通过 LongHub 的明确表单和公开 API 完成。秘密字段只允许写入、替换和删除，不允许回显；
LongHub 的诊断、日志和遥测不得上传用户的 API Key、Token、聊天正文或本地路径。

## 云端 Skill 调用边界

本地适配器只包含 `skill_id`、`service_id`、版本、展示信息和输入/输出 Schema。真正注册 OpenClaw
工具的是一个受支持版本的通用 Tool Plugin；它在 `execute` 时读取 OpenClaw 提供的运行时上下文，
把业务输入和上下文转给 Manager 执行专用 Bridge。调用必须经过 LongHub 本地 Bridge，再由 Cloud API
完成账号、订阅、设备、Agent 绑定、额度、并发、幂等和权限复验。

OpenClaw 的 `agentId/sessionKey/sessionId` 可能在兼容版本中缺失，且上游明确不把它们当作抵御本机
操作者或被修改插件的安全边界。它们只作为审计/幂等元数据；服务端授权以设备凭据、已登记的 Agent
绑定、Skill Release 和订阅 entitlement 为准，不能直接信任请求体中的任意 Agent 字符串。

Cloud API → Executor 的内部凭据和请求字段见
[executor-credential-v1](../../contracts/cloud-skill-adapter/executor-credential-v1.md)。

Executor 只接受 Cloud API 签发的单任务短时凭据，不公开公网地址，不接受客户端 Bearer，不返回源码、
完整提示词、内部 URL、堆栈或实现细节。用户可以停用、解绑、删除或编辑本地适配器；篡改后的摘要/签名
或未知版本不会被 Manager 安装/启用，也不能因此编辑、导出或替换云端实现。

“实现不下发”是可验证目标；无法承诺用户不能通过黑盒调用推测业务行为，因此高价值 Skill 还必须采用
输入最小化、输出收敛、速率/额度限制和滥用检测。

## 版本与兼容

- `longhub/manager-runtime/v1`：原生 Node/OpenClaw 安装和健康 manifest。
- `longhub/cloud-skill-adapter/v1`：签名薄适配器契约。
- `longhub/native-config-backup/v1`：本机原生配置备份/恢复的摘要与原子替换边界（实现见
  `apps/longhub-manager/internal/configbackup`）。
- 每个 OpenClaw 版本建立 CLI/RPC 能力矩阵和真实 Windows 回归记录。
- Manager 与 Cloud API 版本独立；Skill 适配器声明最低 Manager、Node 和 OpenClaw 版本。

## 非目标

- 不复制或改造 ClawPanel 代码、文案或资产；仅参考其外部运行时和管家面板交互。ClawPanel 的
  `CC BY-NC-SA 4.0` 许可明确限制商业用途和收费服务，LongHub 不把它作为可直接复用的商业底座。
- 不把 LongHub 变成 OpenClaw 的强制模型代理。
- 不限制用户自己的 OpenClaw Skill、Provider 或模型；第三方制品风险由用户自行承担。
- 不向客户端分发龙枢私有 Skill 的执行实现。
