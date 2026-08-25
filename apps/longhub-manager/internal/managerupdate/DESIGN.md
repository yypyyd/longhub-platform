# Manager 更新事务设计

## 目标与非目标

目标是让 Manager 安装包具备可验证的发布身份、摘要完整性和失败回滚。非目标是复制 Node/OpenClaw、
迁移原生用户数据、让更新服务替代 Windows Installer，或把公网返回的公钥当成信任根。

## 架构

```text
Cloud API /v1/client-releases/latest
             |
             v
      Client (HTTPS, no redirect)
             |
   Parse + Ed25519 + rollout + digest
             |
             v
   private update root / pending-update.json
             |
        confirmed installer
             |
   Manager startup health window (30s)
       |                     |
   mark healthy         3 failures -> signed rollback installer
```

`pending-update.json` 同时保存目标与旧版本签名 envelope。每次读取都重新验签，并且目标安装器必须
位于更新根目录；回滚安装器必须匹配旧版本 manifest 的固定文件名、大小和摘要。程序目录和 Credential
Manager 是 Installer 的责任，模块只启动已经验证的安装器。

## 安全决策

| 日期 | 决策 | 理由 |
| --- | --- | --- |
| 2026-08-16 | 固定 `longhub/client-update/v2` 与 product surface | 防止其它 LongHub 制品复用 Manager 更新通道 |
| 2026-08-16 | 禁止 HTTP 重定向并绑定下载路径 | 防止签名元数据与二进制被拆到不同信任域 |
| 2026-08-16 | pending 状态保存完整 envelope 且启动时验签 | 防止本地可写状态把回滚路径指向任意可执行文件 |
| 2026-08-16 | 三次失败后才回滚 | 允许一次网络/冷启动抖动，同时避免无限重启循环 |

## 失败和恢复

- 公钥缺失、签名错误、版本降级、灰度未命中：状态为 `rollout_pending` 或 `unavailable`，不下载。
- 下载大小/摘要错误：删除临时文件，不覆盖同名目标。
- 目标安装器启动失败：pending 保留，Windows Task Scheduler/托盘下次启动继续计数。
- 第三次目标启动：先将 phase 改成 `rollback`，再启动经过验签的旧安装器；旧版本确认启动后清除 pending。
- Manager 只触碰自身安装和更新目录，原生 OpenClaw 数据由用户保留。

## 已知限制

正式发布必须由外部审批流程提供生产 Ed25519 公钥、签名安装包和 Windows 代码签名证书。仓库中的
`pending` trust asset 是开发 fail-closed 状态，不能作为上线证据。真实 Windows Installer/UAC、休眠/重启
和安装失败回归仍需干净 Windows VM 验收。
