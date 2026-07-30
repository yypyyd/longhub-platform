# LH-040-14 最小匿名运行指标与遥测边界验收记录

日期：2026-07-30  
范围：`@longhub/observability`、LongHub Desktop、LongHub Cloud API、PostgreSQL migration 006、OpenAPI

## 结论

已建立严格 `longhub/client-telemetry/v1` 最小闭环。Desktop 上报版本、粗粒度启动耗时与 active Agent
数量桶、Gateway 状态、更新结果和固定公开产品错误码；网络或服务端失败只丢弃当前内存批次。Cloud
要求已激活设备凭据，按凭据限流后立即写入无身份字段的 UTC 小时聚合，不保存逐设备原始事件。

本项不建立运营面板，不采集聊天成功率、上游请求延迟、崩溃转储或诊断导出内容。

## 固定边界

| 项目 | 约束 |
|---|---|
| schema | `longhub/client-telemetry/v1`，对象与 fields 都拒绝未知键 |
| 批次 | 1—32 项，HTTP 请求体最多 16 KiB |
| 时间 | 服务端只接受前后十五分钟内的 ISO 时间 |
| 鉴权 | 只接受仍有效的已激活设备 Bearer |
| 限流 | 单 Cloud 进程内每设备 120 批/小时 |
| 客户端队列 | 仅内存、五秒批量、无落盘、无无限重试，失败丢弃 |
| 存储 | UTC 小时聚合，只含版本、平台/架构和固定枚举值及 count |
| 禁止内容 | 设备/用户/租户/会话 ID，Token，聊天，提示词/回答，文件，工具输入输出，URL，端口，PID，路径，异常/堆栈，自由标签 |

## 事件白名单

- `client_started`：启动耗时桶与 active Agent 数量桶。
- `gateway_state`：`starting/running/restarting/config_error/failed/stopped`。
- `client_update_result`：固定检查、下载、安装、健康和回滚结果。
- `product_error`：现有 `LH-xx-nnn` 公开产品错误码。

`client_telemetry_hourly` 没有 JSONB 或身份列，数据库 CHECK 进一步约束 event/value/Agent 桶组合。Bearer
只在请求处理期间用于激活复验和限流 Map，不传给 Store。

## 自动化证据

- 共享契约测试：接受规范事件；拒绝身份、自由文本、URL/标签、未知字段、过期时间；验证粗粒度桶。
- Cloud 路由测试：401/403 门禁、16 KiB、固定契约、小时聚合无身份、同维度累加和 120 批限流。
- Desktop 测试：Authorization 只在 Header，body 无凭据/身份；网络失败 resolve 且后续批次仍可发送。
- OpenAPI 契约测试：路径、严格 schema 和 `additionalProperties: false` 已冻结。

## 遗留边界

- 多实例 Cloud 前要把限流迁移到共享设施；聚合表仍不得增加设备身份。
- 崩溃率、聊天成功率、上游延迟和运营面板需要单独设计分母、保留期、访问控制和隐私说明。
- 本任务不部署线上、不生成安装包；正式发布仍受证书、品牌资产、Update 公钥和 Node 版本门禁约束。

## 回归结果

2026-07-30 在仓库根目录执行：

- `pnpm test`：66 个测试文件、342 项通过；5 项 PostgreSQL 条件集成测试因未配置测试数据库而跳过。
- `pnpm typecheck`：17 个 workspace、29 个 Turbo 任务通过。
- `pnpm lint`：17 个 workspace、29 个 Turbo 任务通过。
- `pnpm build`：17 个 workspace 通过。

当前 Node 为 24.14.0，低于 Desktop 打包门禁要求的 24.15.0；本轮只执行代码构建，不生成或替换候选安装包。
