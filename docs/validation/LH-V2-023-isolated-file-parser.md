# LH-V2-023 隔离文件解析验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 解析运行于隔离子进程，父进程设置输入大小、输出大小、时间和异常退出门禁。
- 二进制、符号链接、压缩容器、扩展名伪装、超限、超时与崩溃安全失败。
- 成功结果只作为文本经公开 `chat.send` 发给绑定会话，不暴露文件路径。

## 证据

- `apps/longhub-desktop/src/isolated-file-parser.ts`
- `apps/longhub-desktop/src/file-parser-worker.ts`
- `apps/longhub-desktop/test/file-capability.test.ts`
