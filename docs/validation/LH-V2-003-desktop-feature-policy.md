# LH-V2-003 Desktop Feature Policy 验收

> 状态：代码完成  
> 日期：2026-07-30  
> 部署状态：未部署

## 已完成

- Desktop 复用 @longhub/feature-policy 的唯一严格解析与合并算法，不维护宽松副本。
- 独立 longhub/feature-policy-cache/v1 缓存精确绑定 Cloud origin 与 device_id。
- 200 响应限制为 64 KiB；304 使用 ETag 在线确认，默认每 30 秒刷新且合并并发请求。
- 缓存通过 0600 独占临时文件和原子 rename 写入；拒绝符号链接、非文件、未知字段和过期内容。
- 仅网络异常、429、5xx 可使用未过期缓存；401/403 和协议错误清除内存状态及普通文件缓存。
- 离线缓存只放行通过完整 entitlement/permission 判定的低风险功能；高风险固定 POLICY_OFFLINE。
- emergency_disabled 在发布新快照后立即改变本地判定，并向上层回调新增停用 feature ID。
- Main 在设备激活后启动首次刷新和轮询；策略不可用不阻断 0.4.1 既有聊天，在更新停机和退出时停止。
- 日志只记录 policy_version、source、feature 数量、固定错误 reason 或紧急 feature ID，不记录 Token
  和策略正文。

## 自动化证据

| 门禁 | 结果 |
|---|---|
| Desktop typecheck | 通过 |
| Feature Policy Coordinator 专项 | 13 项通过 |
| Desktop 全量测试 | 45 文件、232 项通过 |
| 既有存储维护回归 | 通过；临时文件白名单覆盖两类独立缓存 |

## 覆盖场景

- 网络成功写缓存且文件不含设备 Token。
- ETag 条件请求与 304 绑定缓存。
- 跨设备、跨 origin、过期和符号链接缓存拒绝。
- 401/403 不回退；未知字段和超限响应拒绝。
- 瞬时故障低风险缓存可用，高风险缓存拒绝。
- 紧急停用即时判定与回调。
- entitlement/permission 缺失分别给出稳定原因。
- 并发 refresh 只发出一个网络请求。

## 仍需后续任务验证

003 只提供策略协调和本地判定底座。005/006 接入真实产品入口与写操作后，还需补充真实 Electron
点击、紧急撤销中断产品流程和端云 smoke；这些属于对应任务与 007 候选发布门禁，不降低本项代码完成
结论。本机 Node 24.14.0 低于 Desktop 声明的 24.15.0，正式 Electron/发布验证必须使用项目兼容版本。
