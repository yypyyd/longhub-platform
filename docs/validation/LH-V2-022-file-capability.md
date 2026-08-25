# LH-V2-022 一次性文件能力验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 文件只能由 Main 原生选择器产生随机句柄，绑定窗口来源、Agent 与 Session。
- 产品窗口和聊天消息不取得绝对路径；链接、非普通文件、越界来源、取消与句柄重放均拒绝。
- 解析或发送完成后清空暂存，一次性句柄不可复用。

## 证据

- `apps/longhub-desktop/src/file-capability.ts`
- `apps/longhub-desktop/test/file-capability.test.ts`
- Desktop 安全档与完整回归通过。
