# LH-040-04 ASAR 与外置运行时验收

日期：2026-07-29  
版本：0.4.0 内部候选  
结论：已完成；未部署、未提交、未推送，线上仍为 0.3.7。

## 目标与结论

Windows 包已启用 ASAR。Electron 自己消费的 Main、Renderer、激活资源、Core 与 Skill Worker 位于
`resources/app.asar`；随安装包分发的独立 Node 25.9.0 无法读取 ASAR，所以只把 OpenClaw、
LongHub Tool Bridge 和两者的生产依赖闭包放在 `resources/app.asar.unpacked/node_modules`。

不能只解包 `openclaw` 包本身：OpenClaw Gateway 会从顶层 `node_modules` 加载数百个传递依赖、
原生模块、Control UI 和命令资源。按包边界计算的安全闭包仍然很大，但它是独立 Node 的真实运行
边界，不再包含 Desktop `dist`、激活页、Renderer 和 LongHub Core 业务包的无条件展开。

## 更新与同步机制

`openclaw-runtime-packages.json` 记录：

- schema 与锁定 OpenClaw 版本；
- 根包 `openclaw`、`@longhub/openclaw-bridge`；
- 289 个允许外置的包名；
- 每个包实际解析到的版本集合。

构建前从当前 workspace 和 lockfile 重新计算闭包并与清单逐字比较。OpenClaw、Bridge 或任一传递
依赖更新后，旧清单会让构建失败；开发者必须运行 `pnpm --filter longhub-desktop runtime:manifest`，
审查新增/移除包、原生二进制和许可证，再重跑真实打包验收。Darwin、Linux 和 win32-arm64 的
可选原生包在 Windows x64 构建中明确排除。

## 打包结构证据

| 指标 | 旧版全部展开 | 当前 ASAR 候选 |
|---|---:|---:|
| `resources/app` 普通目录 | 26,102 文件 / 261,560,890 bytes | 不存在 |
| `app.asar` | 不存在 | 12,431,893 bytes |
| `app.asar.unpacked` | 不适用 | 25,898 文件 / 256,412,514 bytes |
| 允许外置包 | 无边界 | 289 |
| 实际含文件的外置包 | 无边界 | 285 |

发布校验逐个扫描外置文件；不属于清单包、外置 `dist`、缺失 OpenClaw/Bridge 入口、残留
`resources/app` 或 ASAR 内缺 Main/Renderer/激活资产都会失败。品牌清单和图标从 ASAR 直接读取并
与源码 SHA-256 比较。

## 真实运行时验收

使用 `release/win-unpacked` 中的真实文件完成：

1. `龙枢.exe + ELECTRON_RUN_AS_NODE=1` 从 `app.asar/dist/core-process.js` 完成 `core.hello`；
2. 同一 Electron 可执行文件从 ASAR 启动 Skill Worker，`echo-upper("asar")` 返回 `ASAR`；
3. 内置 Node 从 `.unpacked` 运行 OpenClaw `plugins inspect --runtime`，Bridge 状态为 loaded，注册
   `longhub_resume_screen`；
4. 内置 Node 启动真实 OpenClaw Gateway，`GET /chat` 返回 Control UI；
5. OpenClaw 版本为 `2026.7.1-2 (0790d9f)`。

Desktop 源码验证覆盖 32 个测试文件、119 项并全量通过；新增发布/路径测试 8/8 通过。打包态
Bridge/Gateway 另使用安装目录中的真实 Node 重复验证，不依赖源码测试的进程环境。

## 当前候选制品

- 安装器：`apps/longhub-desktop/release/LongHub-Setup-0.4.0.exe`
- 大小：160,483,560 bytes
- SHA-256：`1E78823925D5F343D84CF1CBDE6649D676D2D892A4BC76EBB6F316AC397479DB`
- blockmap SHA-256：`8E8E6E793F68E3FF2E70B433BFB494C338BDB5847D637F7A3B8250BE0021E695`
- 内置 Node：v25.9.0，OpenJS Foundation Authenticode 与时间戳有效
- 安装器、`龙枢.exe`：未签名，仅内部模式接受
- 品牌状态：temporary，仅内部模式接受

相对 LH-040-03 候选，安装器增加 602,114 bytes（约 0.38%）。ASAR 的目标是收紧应用文件和运行时
边界，不承诺显著缩小压缩安装器；OpenClaw 的真实 Node 闭包仍占主要体积。

## 遗留与发布限制

- 正式签名证书、预期 Subject 和审批后的正式图标仍未到位，LH-040-01 保持进行中；
- 当前候选不得作为正式版上传或覆盖线上 0.3.7；
- 发布暂存通过 pnpm legacy deploy 展开 workspace 符号链接，冷构建约增加两分钟；CI 可缓存内容
  寻址存储，但不能跳过闭包漂移和打包态运行验证。
