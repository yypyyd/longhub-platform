# LH-V2-025 设备本地个人资料验收

> 状态：代码完成  
> 日期：2026-07-31

## 结果

- 个人资料只写入当前设备 userData，以 Windows owner hash 和 Agent 双重隔离。
- 使用严格版本、普通文件检查、同目录临时文件与原子 rename；损坏、链接或 owner 不符安全失败。
- 支持删除与恢复，数据不上传企业知识或遥测端点。

## 证据

- `apps/longhub-desktop/src/local-personal-profile.ts`
- `apps/longhub-desktop/test/knowledge-personal-profile.test.ts`
- `apps/longhub-desktop/test/user-data-center-service.test.ts`
