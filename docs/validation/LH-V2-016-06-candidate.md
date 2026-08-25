# LH-V2-016 LongHub Desktop 0.6.0 内部候选验收

> 状态：候选完成（内部，非公开发布）  
> 日期：2026-07-31

## 制品

| 项目 | 值 |
|---|---|
| 安装包 | `apps/longhub-desktop/release/LongHub-Setup-0.6.0.exe` |
| 大小 | 163,126,652 bytes |
| SHA-256 | `222f56f8884686612a2d5f4cc13257ee4b1116f8a4bdd3721a91690dd1110091` |
| blockmap SHA-256 | `37426cf2eb41e616e32cd9b01de8b07d7a493c22ee95258e4849c6f0ed4bf9a3` |
| 内置 Node | v25.9.0，OpenJS 有效签名与可信时间戳 |
| OpenClaw | 2026.7.1-2 (`0790d9f`) |

## 门禁

- Desktop：Node 25.9 下 53 文件 261 项通过。
- Cloud：20 文件 107 项通过；真实 PostgreSQL 16 Store 8 项另行通过。
- 打包冒烟：Core、Worker、Bridge、Gateway 全通过。
- ASAR：固定产品资源、更新信任清单、Skill 信任清单与源码逐字节一致；外置 25,898 文件全部归属
  OpenClaw 运行时 allowlist。
- 恶意包/未知字段/脚本/native/插件/URL、未知签名密钥、版本覆盖、兼容不符、未授权、撤销、跨 Agent
  binding 和升级补偿均有自动化拒绝证据。

## 未满足的正式发布条件

当前品牌为 `temporary`，Update 与 Skill 信任清单为 `pending`，安装包和主程序未签名。因此只允许内部
候选；正式 `dist` 会拒绝构建。生产 Skill/Update 私钥、审批公钥和 Authenticode 证书仍依赖 KMS、品牌与
安全审批，不能由本地开发代替。
