# LH-040-01 Windows 代码签名与品牌门禁

> 状态：进行中（发布门禁已完成，产品头像已替换，等待外部证书与正式品牌审批）  
> 客户端：LongHub Desktop 0.3.7  
> 日期：2026-07-29

## 当前事实

- 仓库和构建机未发现龙枢代码签名证书。
- `LongHub-Setup-0.3.7.exe` 与 `龙枢.exe` 当前 Authenticode 状态为 `NotSigned`。
- 内置 Node 25.9.0 的 OpenJS Foundation 签名和 Microsoft 时间戳为 `Valid`。
- 2026-07-30 已使用产品方提供的 `longhub-avatar-source.png` 全面替换临时“龙”字图标；
  `scripts/build-icon.py` 只做确定性缩放和格式转换，不再生成视觉内容。品牌清单尚未补齐正式审批记录。

因此当前候选包只能内部测试，LH-040-01 不能标记为已完成。

## 已落地门禁

### 两条构建通道

- `pnpm --filter longhub-desktop dist:internal`：内部候选；显式允许龙枢安装器和主程序未签名。
- `pnpm --filter longhub-desktop dist`：正式发布；品牌或签名任一不满足即失败。

两条通道都检查：

- 安装包版本、blockmap、解包目录和激活页关键资源。
- 内置 Node 是否满足 OpenClaw engines。
- 内置 Node 的官方 Authenticode 签名和可信时间戳。
- 源码与安装包内品牌资产摘要是否一致。

### 正式品牌要求

`assets/brand-manifest.json` 记录审批状态、审批人、审批时间及三类资产 SHA-256。正式发布要求：

- `status=approved`，并填写 `approved_by` 与合法 ISO 时间 `approved_at`。
- `source` 必须指向正式视觉稿来源，不能继续使用临时 `scripts/build-icon.py`。
- SVG、256×256 PNG 和 ICO 摘要与清单一致。
- ICO 包含 16、24、32、48、64、128、256 像素图层。
- 安装包内资产必须与源码完全一致。

当前清单为 `temporary`，正式构建会在调用 electron-builder 之前安全失败。

### 正式签名要求

构建环境注入：

```powershell
$env:CSC_LINK = '<PFX 路径、受控 URL 或 CI secret>'
$env:CSC_KEY_PASSWORD = '<CI/构建机密钥存储中的密码>'
$env:LONGHUB_EXPECTED_SIGNER_SUBJECT = '<证书 Subject 应包含的组织名>'
pnpm --filter longhub-desktop dist
```

PFX、私钥和密码禁止写入仓库。正式构建后使用 Windows `Get-AuthenticodeSignature` 重新检查：

- 安装包与 `龙枢.exe` 状态均为 `Valid`。
- 两者 Subject 均包含预期组织名，防止误用构建机上的其他证书。
- 两者均存在可信时间戳，证书过期后仍可验证签署时有效性。

## 自动化证据

`release-verification.test.ts` 当前 4/4 通过，覆盖：

- 临时图标允许内部候选、拒绝正式发布。
- 图标内容漂移但清单未更新时拒绝。
- 未签名、签名主体错误或缺少时间戳时拒绝。
- 内置 Node 版本范围检查。

发布验证器还会直接调用 Windows Authenticode 验签；不会只依赖 electron-builder 的“已签名”日志。

真实 `dist:internal` 已通过产物后置门禁：

- 安装包：`LongHub-Setup-0.3.7.exe`
- 大小：159,865,897 bytes
- SHA-256：`A9F4BD3255ED0E95B2F6E8F3474741D9BEC96284E8DACC78BCA85E01F2372BD1`
- blockmap SHA-256：`A25492886E459C6781AD3EDE389B0895ADB3DDED43CEE63D7DE3F0037414D252`
- 品牌状态：`temporary`
- 安装包/主程序：`NotSigned`，仅在 internal 模式接受。
- 内置 Node：v25.9.0，OpenJS Foundation 签名与 Microsoft 时间戳均为 `Valid`。

### 2026-07-29 最终回归

- Desktop 使用内置 Node 25.9.0、单 worker 串行执行：28 个测试文件、107 项测试全部通过。
- 先前 Turbo 全仓并发中的 1 项 `spawnSync` 超时已用同一 Node 单独复跑，8/8 通过；确认是多个真实 Gateway/Electron 用例并发争抢资源，不是发布门禁回归。
- 全仓 `typecheck`、`lint`、`build` 均通过，`git diff --check` 无错误。
- `verify:release:internal` 对真实候选安装包复验通过。
- `dist --mode public` 在 electron-builder 前按预期失败：临时品牌清单不能用于正式发布。
- 解包目录中的 `brand-manifest.json` 与源码 SHA-256 均为 `6CCC2AF4897EDAC5AC4D6C879A2C25E6D02A6EFEBF31E5A9770B4BBAE78FEEF1`。
- 仓库未发现 PFX、P12、PVK、PEM、KEY 等证书或私钥文件。
- 变更、质量和安全校验通过；安全扫描为 0 个严重、高危、中危或低危问题。

## 外部材料清单

要完成 LH-040-01，还需要：

1. 可信 Windows 代码签名证书或受控签名服务。
2. 证书的最终 Subject 组织名，用于配置 `LONGHUB_EXPECTED_SIGNER_SUBJECT`。
3. 正式 SVG/PNG/ICO 视觉稿及产品审批人。
4. 最终发行渠道，用于完成安装、升级、卸载与 SmartScreen 实机验收。

材料到位后替换同名图标、更新品牌清单并运行正式 `dist` 即可，不需要重新设计客户端界面。
