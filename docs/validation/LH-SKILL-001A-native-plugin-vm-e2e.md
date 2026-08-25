# LH-SKILL-001A 原生 Cloud Plugin 隔离 VM 验收

> 日期：2026-08-10
> 状态：VMware Ubuntu 真实 OpenClaw/Gateway fixture 闭环通过；生产发布门禁未关闭

## 验收目标

确认 Manager 验签的固定 tgz 字节能够通过真实 OpenClaw `2026.7.1-2` 完成 `npm-pack:` install/upgrade，
并在 Gateway restart 后注册 `longhub_cloud_skill`，通过一次性 enrollment 调用 Manager Cloud Skill Bridge；
已有 active credential 时，用户确认的 Manager 计划 restart 还必须为新进程准备新的单次 enrollment，使
Gateway 长期 token 不落入 `.env` 或普通文件也能恢复执行。本记录验证本地集成契约，不把 fixture
Cloud/Model 结果记作生产 Cloud API/Executor 证据。

## 隔离边界

- 执行环境是 VMware Workstation 25.0.1 中的专用 Ubuntu 24.04.4 LTS VM `LongHub-OpenClaw-Ubuntu`。
- VM 使用 NAT，VMware shared folders/HGFS、拖放和剪贴板集成关闭；宿主项目只通过 SSH 复制到 VM，
  宿主 OpenClaw 未参与安装、启动、配置或验证。
- 测试读取 DMI 并强制要求 `VMware, Inc.` / `VMware Virtual Platform`，同时拒绝 HGFS、9p、drvfs
  等宿主共享挂载。
- OpenClaw 版本固定为 `2026.7.1-2`，配置、state、workspace、插件和 Gateway 均位于 VM 临时目录。
- artifact 使用 VM fixture Ed25519 key 生成 detached signature，再由真实 Manager verifier 验签并复验
  tgz 大小与 SHA-256；该 key 不是生产公钥。
- Model 与 Cloud API 使用 VM 内回环 fixture。设备、Manager、Gateway 和模型 token 均为测试凭据。

## VM 网络与图形桌面

- VM 使用 DHCP，地址不是稳定的测试标识。本次重启后观察到的地址为 `192.168.2.128`；历史运行曾为
  `192.168.2.129`。文档、脚本和验收步骤不得把任一地址写成固定 endpoint。
- 执行前通过 VMware 工具获取当前地址：

  ```text
  vmrun -T ws getGuestIPAddress "<VMX_PATH>" -wait
  ```

  `<VMX_PATH>` 指向 `LongHub-OpenClaw-E2E` 的 VMX 文件；先用 `vmrun -T ws list` 确认当前运行实例。
- Ubuntu GNOME 图形桌面已启用，显示管理器为 GDM，用户 `longhub` 配置为自动登录，桌面会话使用 Xorg；
  空闲锁屏和自动锁定已关闭。图形桌面只用于 VM 操作者观察和故障诊断，不改变无宿主盘挂载、无 Windows
  互操作和 fixture 网络边界。

## 执行路径

1. 真实 `nativeplugin.Controller` 读取签名 manifest/tgz，完成验签与摘要复验，将相同字节写入一次性私有
   staging。
2. Controller 依次执行固定 install 和 `--force` upgrade，并以真实 runtime inspect 验证
   `source=npm`、`artifactKind=npm-pack`、`artifactFormat=tgz`、固定 tarball 及本次 `sourcePath`。
3. Manager 将固定回环 Bridge URL 和一次性 enrollment code 原子写入原生 Gateway `.env`。
4. Gateway 首次前台启动后停止，再正常重启；`tools.catalog` 必须发现唯一 `longhub_cloud_skill` 工具。
5. 前两个独立 Agent turn 调用该工具；第一次兑换 enrollment，第二次复用同一 Gateway 进程内 execution
   credential，此时只有一次 enrollment POST。
6. 在 Manager 已有 active credential 时，模拟用户确认的 Manager 管理 restart：先停止旧 Gateway，再向
   `POST /api/v1/runtime/control` 提交 `{ "action": "restart", "confirm": true }`。Manager 启动前向原生
   `.env` 覆盖写入新的单次 enrollment，当前 bearer 在新进程兑换前保持有效；随后由 launch hook 启动新进程。
7. 新 Gateway 进程兑换第二个 enrollment，第三个 Agent turn 成功；已使用 code 再次从 `.env` 清理，长期
   `LONGHUB_EXECUTION_TOKEN` 始终不写入 `.env` 或普通文件。

对应集成测试：
[`real_gateway_e2e_test.go`](../../apps/longhub-manager/internal/httpapi/real_gateway_e2e_test.go)。

```bash
cd /path/to/longhub-platform/apps/longhub-manager
LONGHUB_REAL_GATEWAY_E2E=1 \
LONGHUB_E2E_PLUGIN_ARCHIVE=/path/inside/vm/longhub-openclaw-cloud-plugin-0.1.0.tgz \
go test -tags integration ./internal/httpapi \
  -run '^TestRealOpenClawGatewayCloudSkillE2E$' -count=1 -v
```

该命令只允许在上述专用 VM 内运行；测试自身拒绝错误 DMI、宿主共享挂载和非 VM 内绝对 tgz 路径。

本轮对与宿主 Manager 源码哈希一致的 VM 副本重新执行：

```bash
go test -count=1 ./...
go vet ./...
```

候选 tgz 为 `19969` bytes，SHA-256 为
`f6dca9f4c22a66a6551cb80b3cb3c78a3038ccba02ed793fbc2e208e810eaeef`。对解包后候选执行
`openclaw plugins validate` 时，锁定版 OpenClaw 的 authoring CLI 需预加载其 ESM tool-plugin SDK，并让临时
解包目录解析到 VM 已安装的 `typebox`：

```bash
NODE_PATH=/opt/longhub-node-global/lib/node_modules/openclaw/node_modules \
NODE_OPTIONS=--import=file:///opt/longhub-node-global/lib/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js \
HOME=/tmp/longhub-plugin-validate/home \
OPENCLAW_HOME=/tmp/longhub-plugin-validate/home/.openclaw \
OPENCLAW_STATE_DIR=/tmp/longhub-plugin-validate/home/.openclaw \
openclaw plugins validate --root /tmp/longhub-plugin-validate/root/package --entry index.js
```

结果为 `Plugin longhub-cloud-skill is valid.`。预加载只规避该 CLI 在 Node/OpenClaw 锁定组合下的
ESM/CJS 加载竞态，不替代后续的真实 Gateway 安装与运行时验收。

## 通过结果

| 检查项 | 结果 |
|---|---|
| 真实 Controller install | 通过 |
| 真实 Controller `--force` upgrade | 通过 |
| runtime inspect 的 npm-pack 来源、格式、tarball 与私有 sourcePath | 通过 |
| Gateway 正常 restart 后工具注册 | 通过 |
| `tools.catalog` 包含 `longhub_cloud_skill` | 通过 |
| 前两个 turn 复用首次进程内 token | 通过；首次 enrollment POST 恰好 1 次 |
| active credential 下为计划 restart 准备新单次 enrollment | 通过 |
| restart 后新进程兑换并完成第三个 turn | 通过 |
| Agent turn | 恰好 3 次 |
| enrollment POST | 恰好 2 次 |
| Manager execute | 恰好 3 次 |
| Cloud fixture 请求 | 恰好 3 次 |
| 已使用 enrollment code 从 `.env` 清理 | 通过 |
| 长期 Gateway token 未写入 `.env`/普通文件 | 通过 |
| `openclaw plugins validate` | 通过 |
| Manager `go test -count=1 ./...` / `go vet ./...` | 通过 |
| Manager race tests (`executionauth`/`executionenv`/`runtime`/`httpapi`) | 通过 |

最终事务代码上的真实 Gateway E2E 耗时 `55.19s`，日志摘要为
`enrollment_posts=2 execute_posts=3 agent_turns=3`；完成后 VM 中无残留 Gateway/OpenClaw 进程。

## 启动恢复覆盖范围

本轮只覆盖 Manager 管理且用户明确确认的计划 start/restart：Manager 能在启动前看到 active credential，
生成新的一次性 enrollment 并写入已绑定的原生 `.env`。这不是长期 token 落盘恢复。

外部 Gateway 崩溃、用户绕过 Manager 直接启动、系统开机启动或 Scheduled Task 自动启动不经过该准备步骤；
这些路径仍需受信 Windows launcher 从 Credential Manager 取得恢复材料并安全注入 Gateway 进程。

## 未关闭的生产门禁

- 内嵌 `longhub/native-plugin-trust/v1` 已记录 approved key `native-plugin-2026-08`（LongHub release
  operator，2026-08-16）；信任根审批不等于 artifact 已发布。
- 当前候选目录尚无外部签名服务生成的正式 `release-manifest.json`/tgz staging，Windows 发行流程也尚未把正式 manifest/tgz
  staging 到 Manager 可执行文件旁固定版本目录。
- 尚未在真实 Windows 用户环境验证 Credential Manager、目录/文件 ACL、权限拒绝和多用户隔离。
- 外部崩溃、系统启动和 Scheduled Task 自动启动尚未完成受信 Windows launcher + Credential Manager 注入
  验收；本轮只覆盖 Manager 管理且用户确认的计划 start/restart。
- enable/disable/uninstall、升级失败恢复、配置/插件生命周期补偿和完整回滚矩阵尚未通过 Windows 验收。
- execution credential 的 rotation/revoke 尚未完成真实 Gateway 纵向复验。
- 本次 Cloud/Model 是 fixture；真实 Cloud API、私网 Executor、KMS、订阅/额度和生产网络边界尚未验收。

## 2026-08-17 状态同步

Manager 资产中的 native plugin trust root 已从 pending 记录为 approved
(`native-plugin-2026-08`)，但本工作区未携带外部签名服务生成的正式 manifest/tgz，因此没有新增可发布
artifact 证据。Windows Manager 候选安装器在 `-AllowUnsigned` 隔离模式下可重复构建，Go test/build 已通过；
其 Authenticode 状态仍为 `NotSigned`，干净 Windows VM 的安装、托盘、Task、Credential Manager/ACL、
升级失败回滚和 rotation/revoke 仍未完成。

因此 `LH-SKILL-001A` 保持“进行中（P0）”，不得据此标记为已发布或已开放。
