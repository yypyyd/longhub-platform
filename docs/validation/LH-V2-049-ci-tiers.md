# LH-V2-049 分级 CI 验收

> 状态：代码完成  
> 日期：2026-07-30  
> 远端状态：工作流已配置，尚未提交到 GitHub 执行

## 已完成

- 根脚本提供 `ci:quality`、`ci:unit-contract`、`ci:smoke`、`ci:security` 和 `ci:full` 可复现入口。
- 单元/契约档覆盖全部 workspace，并从 Desktop 排除真实 OS、Gateway 和 Electron 重路径。
- PR 冒烟覆盖首次激活、真实 Gateway 聊天、Agent 切换/会话恢复、策略刷新和确认中心 Electron 路径。
- 安全档覆盖 Feature Policy/Core/Cloud 边界，以及确认重放、凭据、脱敏、路径、Pack、产品窗口和
  Agent 隔离回归；每日定时运行。
- 全量档执行全部历史 E2E、安装/激活/连续性矩阵，每周定时运行。
- 所有 Windows 工作流锁定 Node 22.22.3，满足内置 OpenClaw 声明的运行区间。
- Linux 合同使用 PostgreSQL 16 service 跑 Store 集成测试，并用真实 Nginx parser 校验公网配置。

## 本地证据

| 分级 | 结果 | 实测时长 | 预算 |
|---|---|---:|---:|
| 单元 + 契约 | 通过；Desktop 35 文件/220 项，其他 workspace 全部通过 | 7 秒 | 10 分钟 |
| 冒烟 E2E | 5 文件/17 项通过，含真实 Electron/OpenClaw Gateway | 56 秒 | 20 分钟 |
| 安全回归 | Desktop 15 文件/85 项及 Feature Policy/Core/Cloud 专项通过 | 6 秒 | 40 分钟 |
| 全量回归 | 29 个 Turbo task；Desktop 47 文件/237 项通过 | 65 秒 | 90 分钟 |
| PostgreSQL 16 | `postgres:16-alpine`，PgStore 7 项通过 | 1 秒测试时间 | 10 分钟作业 |
| Nginx | `nginx:stable-alpine` 的 `nginx -t` 成功 | 3 秒内 | 10 分钟作业 |

四份 workflow YAML 已通过 PyYAML 解析。每档 runner 最后一行输出
`ci.tier.completed` JSON，候选门禁可直接记录实际时长。

## 证据边界

这些结果证明仓库脚本、本机 Windows 路径、容器 PostgreSQL 16 与 Nginx 配置可执行；远端 GitHub
Actions 尚未运行，不能表述为“远端 CI 通过”。Nginx 容器真解析也不替代目标部署主机 reload 前检查。
