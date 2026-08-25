# LongHub Deployment

部署脚本同时准备三个互不混用的制品目录：

```text
/var/lib/longhub/client-releases       Manager .exe (longhub-manager)
/var/lib/longhub/cloud-plugin-releases Plugin .tgz (longhub-cloud-plugin)
/var/lib/longhub/cloud-cli-releases    CLI .tgz (longhub-cloud-cli)
```

Cloud API 只对后两个目录拥有写权限；Nginx 通过固定文件名正则提供 `/downloads/cloud-plugin/*` 和 `/downloads/cloud-cli/*`，Manager 下载仍固定 `/downloads/manager/*`/client release。目录不接受 symlink，上传由 Cloud API 原子暂存并流式计算大小/SHA-256。

## 必需配置

生产需要为 Manager update、Cloud Plugin release、Cloud CLI release 分别配置 signing key ID、private key 和 public key。Plugin/CLI key 不能互用；线上 `signing-key` endpoint 不能替换 CLI 内置 trust root。未配置批准生产 key、AuthentiCode 或 Windows VM gate 时，所有 candidate 保持 paused。

## 部署检查

```bash
./infrastructure/deployment/scripts/install-release.sh <source> <release>
./infrastructure/deployment/scripts/render-nginx.sh --check
```

当前开发环境是 Windows，无法运行 Linux shell 测试（WSL `/bin/bash` 不可用）；必须在 Linux VM/CI 执行 systemd、Nginx、权限和 clean-launch smoke。
