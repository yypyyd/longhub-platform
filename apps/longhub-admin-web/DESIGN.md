# Admin Web 设计

## 发布信息架构

```text
发布
  ├─ Manager（免费，longhub-manager）
  ├─ Cloud Plugin（收费，longhub-cloud-plugin）
  └─ Cloud CLI（收费，longhub-cloud-cli）
```

每个列表调用对应 Cloud API admin route，不能用表面参数把一种制品上传到另一种目录。服务端重新校验版本、固定文件名、文件流大小和 SHA-256，浏览器的校验只提供早期反馈。

## Rollout 与撤回

上传创建 `paused/0%` manifest。管理员只能对最新版本设定 5%、25% 或 100% rollout，暂停会回到 0%；撤回不会删除 release index 或下载文件，公共 latest/version/download 根据 withdrawn 状态返回空、404 或 410。所有 mutation 记录 actor、surface、version、比例和时间。

## 安全边界

Admin token 只用于 Cloud API RBAC；页面不接收私钥，不显示 device token、Executor key 或 Skill 实现。订阅管理只控制 Cloud execution，不关闭用户本地 OpenClaw。

## 已知限制

Cloud Plugin/CLI 的生产 Ed25519 key 和真实 Windows/OpenClaw E2E 已完成；Manager Authenticode 仍未完成。后台可以管理各自候选发布，但不得用 Plugin/CLI 门禁结果替代 Manager 签名门禁，也不得把 unsigned/self-signed Manager 标为 production ready。

## 变更历史

### 2026-08-17 - 独立 Plugin/CLI 发布页

新增 Cloud Plugin 与 Cloud CLI 独立列表、上传、灰度、暂停、撤回和 SHA/key/product 展示；Manager 列表继续固定免费产品面。
