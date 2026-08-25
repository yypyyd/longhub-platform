# LongHub Observability

龙枢统一结构化日志安全出口和严格匿名客户端遥测契约。所有服务和 LongHub Manager 生产日志都应通过
`createConsoleLogger()` 输出，禁止直接记录请求体、模型消息、工具输入输出、用户文件内容或任何凭据。

## 核心能力

- 递归脱敏设备、Gateway、Bridge、会话 Token、API Key、密码和授权码。
- 对自由错误文本中的 Bearer、URL Token、已知密钥前缀和授权码执行兜底清理。
- 调用方可动态登记本次进程已知的秘密值，清理无标签的子进程输出。
- 默认清除 `content/body/input/output/text/prompt/messages/fileContent` 等用户内容字段。
- 循环对象、深层结构、超长字符串和数组安全截断，避免日志序列化导致进程异常或数据放大。
- `redactLogValue()` 可用于审计日志落库前的第二道脱敏。
- `longhub/client-telemetry/v1` 只接受 `manager_version`、OpenClaw 版本、win32 架构、粗粒度桶与固定事件枚举；对象和事件 fields
  都拒绝未知键，并限制 32 项、16 KiB 和前后十五分钟接收窗口。
- `clientStartupBucket()` 与 `clientAgentCountBucket()` 在数据产生处先降精度，避免上传精确耗时或数量。

字段脱敏不能识别没有上下文标签的任意自然语言秘密，因此调用方仍不得把请求/响应正文或用户文件
内容传给 Logger。详细威胁模型和限制见 [DESIGN.md](DESIGN.md)。

当前遥测契约为 clean launch：旧 `desktop_version` 不被识别，也没有兼容别名。
