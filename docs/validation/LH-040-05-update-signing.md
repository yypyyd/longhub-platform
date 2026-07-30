# LH-040-05 客户端更新签名与防回滚验收

日期：2026-07-29

版本：0.4.0 开发分支

结论：代码与契约已完成；未部署、未提交、未推送，线上仍为 0.3.7。

## 目标与信任链

客户端更新不再只信任 HTTPS、文件名或 Cloud 当前响应。Cloud 使用独立 Update Ed25519 密钥签署
严格 manifest；Desktop 只使用安装包预置公钥验签，并记录每个渠道见过的最高发布序列；安装包在
执行前再按签名 manifest 流式验证大小和 SHA-256。

签名覆盖：

- schema 与全局单调 `sequence`；
- `version/channel/platform/arch`；
- `filename/size/sha256/url_path`；
- `published_at`。

用途域固定为 `longhub-client-update-v1\n`，Update key 与 Agent Pack key 强制分离。

## Cloud 发布与下载边界

- 上传最大 1 GiB，实际字节数与摘要来自流，不信任声明值；
- 临时文件、hard link 不覆盖发布和原子 `releases.json`；
- 同版本、较低版本、非法文件名和并发后失效版本均拒绝；
- 旧未签名索引不会自动重签，只停止公开并等待重新上传；
- 当前/历史签名 key 都会验证，未知 key 或磁盘篡改导致公开接口 fail-closed；
- Nginx 只允许 `/downloads/LongHub-Setup-x.y.z.exe`，索引、临时文件和目录列表返回 404。

生产目录约定：

```text
CLIENT_RELEASE_DIR=/var/lib/longhub/client-releases
nginx alias=/var/lib/longhub/client-releases
```

Cloud 服务用户负责写入，Nginx 通过共享只读组读取 `.exe`；`releases.json` 保持 0600，安装器为 0640，
目录建议由共享组持有并设置 2750/setgid。部署时必须先验证两个进程的实际 UID/GID，不能为解决
读取问题改成全局可写。

## Desktop 防回滚边界

- Cloud Base URL 只允许 HTTPS；localhost/127.0.0.1 测试可用 HTTP；
- 响应必须是无额外字段的 `{ release }`，签名 envelope 同样严格；
- 渠道、平台和架构不匹配时拒绝；下载路径必须解析为 Cloud 同源；
- sequence 下降时拒绝，同 sequence 不同 metadata SHA-256 时拒绝；
- 防回滚状态缺字段、未知字段或格式损坏时拒绝，不静默重建；
- 下载后大小或 SHA-256 不一致时拒绝执行。

当前 `ClientUpdateVerifier` 尚未接入 Electron Main 自动更新生命周期。本项先冻结信任与制品验证边界；
后续自动更新任务负责下载暂存、用户提示/静默策略、状态快照、安装、健康检查和失败回滚。

## 密钥轮换顺序

1. 在受控环境生成新 Ed25519 key，私钥进入密钥服务；
2. 先发布同时预置信任旧/新公钥的 Desktop；
3. Cloud 的 `CLIENT_UPDATE_TRUSTED_PUBLIC_KEYS_JSON` 保留旧公钥并加入需要验证的历史 key；
4. 切换 `CLIENT_UPDATE_SIGNING_*` 到新 key，核对 `/signing-key`，再发布新安装器；
5. 覆盖全部允许降级/回滚的客户端后，才从后续 Desktop 与 Cloud 历史集合移除旧 key。

不能先切 Cloud 私钥再等待客户端更新，否则现有客户端会正确地拒绝未知签名 key。

## 验证范围

- Pack Schema：签名用途域、字段篡改、未知字段、版本规范与版本比较；
- Cloud API：legacy 停止公开、鉴权、流式摘要、签名、禁止覆盖/降级、单调 sequence、索引篡改、
  历史 key 轮换与 key ID 冲突；
- Desktop：预置 key、未知 key/签名篡改、HTTPS、损坏状态、重放、同序列异文、文件大小与摘要；
- Admin/Portal：使用嵌套 signed manifest；OpenAPI 冻结公开和管理契约；
- 基础设施：严格 Nginx 下载正则与不可浏览目录。

## 验证结果

- 更新链定向：5 个测试文件、22 项全部通过；
- 全仓：54 个测试文件、234 项通过，4 项 PostgreSQL 外部环境测试按条件跳过；
- 17 个 workspace 包的 `typecheck`、`lint`、`build` 全部通过；
- OpenAPI YAML 成功解析，包含 28 条路径；`git diff --check` 通过；
- Desktop、Cloud API 安全扫描均为 0 Critical/High/Medium/Low；质量门禁通过，仅报告既有长文件告警；
- 变更门禁通过，README、DESIGN、OpenAPI、Nginx、ROADMAP 和本验收记录已同步。

当前 Windows 环境未安装 Nginx 二进制，因此未在本机执行 `nginx -t`；生产变更上线前必须在目标机
使用实际证书路径、用户和目录权限执行 `nginx -t`，失败时不得 reload。

正式 Update 公钥、代码签名证书与正式图标仍是外部发布材料，未到位前不得把内部候选作为正式版本
上线。本任务没有重打或覆盖 LH-040-04 的内部候选，也没有部署到线上 0.3.7。
