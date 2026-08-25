# Deployment 设计

## 目录与权限

Cloud API systemd unit 只对 `/var/lib/longhub/client-releases`、`cloud-plugin-releases` 和 `cloud-cli-releases` 写入；Executor、migrator 和 Nginx 不获得 signing private key 或 Cloud API release index 的写权限。部署脚本先拒绝 symlink，再以固定 owner/group/mode 创建目录。

## 发布路径

```text
Admin upload -> Cloud API stream/hash/sign -> paused release index
                                      |
                                      v
Nginx fixed filename download <- Portal/CLI latest manifest
```

Manager、Plugin 和 CLI 使用不同 filename regex、schema、product surface、目录和 signing key。任何跨面上传、同版本覆盖、路径 traversal、大小不匹配或撤回制品都 fail closed。

## 配置安全

`cloud-api.env.example` 仅列出变量名和占位符，不含真实 secret。systemd 通过 credential 载入四套 Plugin/CLI key material；环境变量只用于开发和显式配置检查。生产 bootstrap 缺少数据库、Executor credential、模型 key 或 release signing key 时拒绝启动。

## 回滚与审计

部署安装脚本对 systemd unit、静态站点和 release 目录使用临时 staging；服务升级失败恢复上一 release。Cloud release 回滚通过 rollout pause 或 withdrawal 完成，不覆盖旧 bytes；每次上传、rollout、pause、withdrawal 写 Cloud audit。

## 已知限制

Linux 权限测试、Nginx 渲染、systemd sandbox 和生产 secret 注入需在 Linux VM/CI 完成。当前仓库只生成 unsigned candidate，不能宣称正式生产安装包已签名。

## 变更历史

### 2026-08-17 - 独立 Plugin/CLI 目录

新增 Cloud Plugin/CLI release 目录、固定下载路由、systemd ReadWritePaths、Nginx substitutions 和独立 signing 配置；Manager 目录保持单独产品面。
