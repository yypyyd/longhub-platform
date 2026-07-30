# LH-040-03 日志与审计脱敏

> 状态：已完成  
> 客户端：LongHub Desktop 0.4.0  
> 日期：2026-07-29

## 验收目标

设备 Token、Gateway/Bridge Token、API Key、授权码和用户文件内容不能出现在 Desktop、Cloud API、
Executor、Worker 的结构化日志或 Cloud 审计详情中。错误文本、循环对象和超长输入不能绕过脱敏或
导致 Logger 崩溃。

## 实现边界

- 共享 `@longhub/observability` 在 JSON 序列化前递归清理敏感键和用户内容键。
- Bearer、URL fragment/query、命令参数、OpenAI/设备密钥前缀和授权码在自由文本中兜底清理。
- Error 只输出 `name/message/code`，不输出 stack；日志元数据不能被业务字段覆盖。
- Desktop Main 和历史原型统一使用结构化 Logger，OpenClaw CLI 输出先脱敏再组成 Error。
- Cloud MemoryStore 与 PgStore 在审计落库前执行第二次递归脱敏。

## 安全边界

自动规则不能可靠识别没有字段名或固定格式的任意自然语言秘密。调用方仍禁止记录请求/响应正文、
模型消息、工具输入输出和用户文件内容；脱敏是纵深防御，不是允许记录原文。

## 验证结果

- `@longhub/observability`：4/4 通过，覆盖递归字段、自由文本、动态秘密值、Error、循环和大小限制。
- Cloud 审计定向：1/1 通过；Cloud 全量：50 passed、4 skipped（PostgreSQL 外部环境条件测试）。
- Desktop 无标签子进程输出：1/1 通过；Desktop 单 worker 全量：31 个文件、115 项全部通过。
- 全仓 `typecheck`、`lint`、`build` 通过；Desktop 真实 Gateway、Electron、激活、Agent 和
  Credential Manager 链路均未回归。
- 变更、质量、安全门禁通过。Desktop/Cloud 源码为 0 Critical/High/Medium；共享 Logger 仅有实际
  控制台 sink 的 1 个 Low 调试模式提示。
- Desktop、Cloud API 与 OpenClaw Bridge 生产源码无直接 `console.*`；私钥标记搜索为 0，
  `git diff --check` 通过（仅 Windows LF→CRLF 提示）。

## 结论

LH-040-03 完成。自动脱敏和调用点最小字段共同生效；Cloud 审计另有落库前第二道防线。本任务不
改变设备凭据、授权、模型或 Agent 数据契约，不需要单独迁移数据库。

## 0.4.0 内部候选

- 安装包：`LongHub-Setup-0.4.0.exe`
- 大小：159,881,446 bytes
- SHA-256：`D3AD1A368C7199263F39568CB6F8EDB4396B20B8F267366AFCD7941CC6A452E8`
- blockmap SHA-256：`D8B4605BC2E1D7FA375303CBC90CF5BCD1E4169AF08F4AAAC5668DF2C2F9EF11`
- 解包应用包含 `@longhub/observability`；使用安装包内置 Node 加载实际打包模块，动态秘密值哨兵返回
  `PACKAGED_LOG_REDACTION_OK`。
- 内置 Node：v25.9.0，OpenJS Foundation Authenticode 与 Microsoft 时间戳均为 `Valid`。
- 品牌状态仍为 `temporary`；安装器和主程序 `NotSigned`，仅内部模式接受。正式发布继续 fail-closed。
