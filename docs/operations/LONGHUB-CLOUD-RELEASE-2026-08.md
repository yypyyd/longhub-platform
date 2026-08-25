# LongHub Cloud 独立发布说明

| 产品面 | 版本 | 初始状态 |
| --- | --- | --- |
| LongHub Manager | 0.1.1 | 代码完成；正式 Authenticode/激活暂停，旧 0.1.0 candidate 继续 paused |
| Cloud Plugin | 0.2.1 | `longhub-cloud-plugin`，生产签名并 active |
| Cloud CLI | 0.1.2 | `longhub-cloud-cli`，生产签名并 active |

本次发布将免费 Manager 与收费 Cloud Skill 完全解耦。Manager 安装包不再包含 Bridge、enrollment、execution credential、Cloud Skill adapter 或插件 artifact。插件直接调用 Cloud API；CLI 负责 Windows 配对、凭据、验签和 OpenClaw `npm-pack` 安装。

## 不可覆盖补丁

- CLI `0.1.1`：修复 Windows `.cmd` 启动，使用已验证的 `ComSpec` 且拒绝控制字符/cmd 元字符。
- CLI `0.1.2`：按真实 OpenClaw inspect JSON 校验插件身份、安装 provenance、工具和 diagnostics。
- Plugin `0.2.1`：默认发送构建时固定的 OpenClaw `2026.7.1-2` 兼容 header，不接受新的敏感环境配置。

## 已通过门禁

- Plugin 与 CLI 使用不同的生产 Ed25519 key；私钥只存在服务端，manifest、大小和 SHA-256 绑定同一份无 registry 运行时依赖的 tgz。
- Linux migration/systemd/Nginx/health、Portal 配对、真实 Windows Credential Manager、CLI pair/status/install/update 已通过。
- OpenClaw runtime inspect 显示 Plugin `0.2.1` loaded、无 diagnostics、无外部依赖，并注册唯一 `longhub_cloud_skill`。
- 插件直连 Cloud API 的真实任务和工具工厂执行通过；旧 Manager `windows` bearer 的 task gate 纳入生产 E2E。

## 独立未完成门禁

Manager 尚无受信任的正式 Authenticode 证书，因此不得把 unsigned/self-signed `0.1.1` 称为生产签名安装包，也不得激活 Manager rollout。支付供应商正式结算上线同样不由本次 Cloud 客户端技术 E2E 代替。
