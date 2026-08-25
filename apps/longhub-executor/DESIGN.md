# Executor 安全设计

## 威胁模型

Executor 假定监听地址所在网络可能被扫描，且客户端、OpenClaw 模型、第三方 Skill 和租户之间
互不可信。需要防御的主要风险是：

- 未授权调用、伪造 Cloud API 请求和把一个租户的任务重放到另一个租户；
- 修改任务/Skill/输入、重放同一个幂等键造成重复执行；
- 超大请求、慢速请求或慢 Skill 消耗执行器内存和工作线程；
- 通过错误消息、堆栈或结果响应泄露云端实现细节。

Executor 不负责账户登录、订阅判定或用户设备授权；这些决策属于 Cloud API。Executor 只信任
共享密钥验证通过且仍在有效期内的单任务凭据，以及自身注册的 Skill 实现。

## 安全决策

1. **短时 HMAC 信封**：`lhx1.<payload>.<signature>` 使用 HMAC-SHA-256，payload 严格固定字段，
   有效期默认 60 秒且上限 5 分钟。凭据不含输入正文、提示词、密钥或实现逻辑。轮换窗口可通过
   `EXECUTOR_CREDENTIAL_TRUSTED_KEYS_JSON` 同时信任有限的历史 key ID，当前 key 仍只由
   `EXECUTOR_CREDENTIAL_KEY_ID/SECRET` 签发。
2. **请求绑定**：签名同时覆盖 `task_id`、`tenant_id`、`skill_id`、`idempotency_key`、输入摘要。
   请求体再次严格校验这些字段并重算摘要，任何不一致都以固定 `CREDENTIAL_BINDING_MISMATCH`
   拒绝。租户只从 Cloud API 的可信设备记录进入签发流程，不接受客户端自报租户。
3. **幂等与重放边界**：缓存键为 `tenant_id + idempotency_key`，缓存指纹含任务、Skill、输入摘要。
   相同请求可安全重试；不同请求复用键返回 `IDEMPOTENCY_CONFLICT`。缓存有 TTL 和容量上限。
4. **资源上限**：请求体默认 1 MiB、读取超时 10 秒、Skill 执行超时 30 秒、响应体默认不超过
   请求上限。超时通过 `AbortSignal` 通知 Skill，并返回稳定的 `EXECUTION_TIMEOUT`。
5. **错误最小化**：所有错误都有稳定代码、短消息、请求 ID 和 retryable 标记；内部异常只写不含
   输入的结构化日志，不向调用方返回 `err.message` 或堆栈。
6. **启动失败即关闭**：生产进程入口要求显式 `EXECUTOR_CREDENTIAL_SECRET`；仅 `createExecutorServer`
   的进程内随机密钥用于测试，避免把隐含密钥误当成跨进程配置。
7. **监听地址默认收紧**：生产入口默认绑定 `127.0.0.1`；跨主机部署必须显式指定
   `EXECUTOR_BIND_HOST` 并由防火墙/服务网格限制为 Cloud API 私网流量。
8. **构建时私有 Registry**：`src/main.ts` 只注入 `src/private-skills/registry.ts` 中静态导入的
   allowlist。请求、管理页面和环境变量都不能指定 Skill 实现或模块路径；未知 ID 失败闭合。
   Registry 不提供 mutator，新增实现必须经过源码审查、重新构建和部署。包根入口不导出私有
   Registry，Manager 和公开适配器制品不得包含该目录。
9. **实现输入再校验**：每个私有 Skill 在执行前验证自己的严格输入对象。以首个
   `longhub.skill.salary-band` 为例，只接受唯一的整数 `level` 字段；错误只抛出
   `SkillInputError`，由 Executor 映射为不含实现细节的固定响应。

## 信任边界

```text
用户/OpenClaw/本地适配器
          │  (设备授权由 Cloud API 复验)
          ▼
      Cloud API ──签发单任务凭据──▶ Executor ──▶ 构建时私有 CloudSkill Registry
          │                             │
          └────任务/订阅/租户审计─────────┘
```

Executor 不嵌入 OpenClaw UI，也不读取本地 OpenClaw 配置。它只执行云端实现并返回结构化结果。

## 已知风险与后续工作

- HMAC 共享密钥泄露会让攻击者伪造 Executor 请求；生产应放在 Secret Manager，并把 Executor 放在
  仅 Cloud API 可达的私网。轮换重叠集合必须在窗口结束后移除旧 key。
- 进程内幂等缓存不是跨实例持久存储；多副本部署必须迁移到共享存储/队列，并在网关层做 mTLS
  或网络 ACL。当前实现的容量和 TTL 仅提供单实例保护。
- `AbortSignal` 只能请求 Skill 合作取消；不合作的实现仍可能继续运行，生产应使用作业隔离/沙箱。
- 订阅、配额和 Skill 撤回必须在 Cloud API 执行点复验，不能把 Executor 的构建时 allowlist 当作
  用户授权。Executor 的实现输入校验是额外边界，不替代 Cloud API 的鉴权与 entitlement 检查。
- JavaScript 实现必然存在于 Executor 的服务端部署制品；镜像仓库、构建日志、source map 和生产
  主机访问权必须按机密资产管理，不能发布到客户端更新源或公开制品仓库。

## 变更历史

### 2026-08-11 - 生产私有 Cloud Skill Registry

**变更内容**：增加 Executor 制品内的构建时固定 Registry，并由生产入口显式注入首个严格校验
输入的私有 Skill。

**变更理由**：让公开客户端只获得调用适配器，同时确保生产 Executor 不依赖动态模块路径且对未知
Skill 失败闭合。

**影响范围**：Executor 生产启动、私有 Skill 实现、输入错误映射、回归测试和服务端制品保护。
