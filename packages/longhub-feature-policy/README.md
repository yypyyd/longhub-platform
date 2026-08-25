# @longhub/feature-policy

Feature Policy V2 的严格契约、确定性合并算法和最终访问判定。它是 Skill、文件、知识、工作流及后续用户
功能的共同安全底座。

## 为什么存在

简单布尔开关无法表达作用域、受众、风险模式、资源上限、数据边界、授权要求和紧急关闭。该模块提供
独立的 `longhub/feature-policy/v2` 严格契约。当前产品为 clean launch，只接受 Manager 版本字段；旧
Desktop 字段会作为未知或缺失字段直接拒绝，不提供别名或兼容解析。

## 核心职责

- 严格解析 Feature Policy 文档，拒绝未知字段、非法 ID、过大响应和过长有效期。
- 按可信 audience、scope_id 和 Manager 版本筛选适用策略。
- 按 deny-wins、风险最高、上限最小和数据策略只收紧规则合并。
- 将各层 required_entitlements 与 required_permissions 取并集，防止下层抵消上层要求。
- 给 Cloud 与 Manager 返回稳定、可审计的访问判定原因。

本模块不负责策略持久化、管理员认证、HTTP 缓存、Manager 定时刷新或具体业务执行；这些由 Cloud 和
Manager 调用方实现，并在执行点再次复验本模块的判定。

## 依赖关系

模块无运行时第三方依赖。Cloud API、Manager 和后续 Core 策略适配器依赖它；它不依赖上述应用，避免
端云出现两套合并算法。

## 快速使用

    import {
      decideFeatureAccess,
      parseFeaturePolicyJson,
      resolveFeaturePolicy,
    } from "@longhub/feature-policy";

    const document = parseFeaturePolicyJson(responseBody);
    const policy = resolveFeaturePolicy(document, "skill.catalog", {
      manager_version: "0.5.0",
      audience: "user",
      scope_ids: { tenant: "tenant-a", device: "device-a", agent: "longhub.agent.hr" },
    });
    const decision = decideFeatureAccess(policy, {
      entitlements: ["plan:standard"],
      permissions: ["skill:catalog:read"],
    });

缺失、未生效或过期策略不得用于授权。调用方应把 POLICY_NOT_FOUND、FEATURE_DISABLED 和
EMERGENCY_DISABLED 视为安全关闭。

## 公共 API

| API | 用途 |
|---|---|
| parseFeaturePolicyDocument | 严格解析已反序列化对象 |
| parseFeaturePolicyJson | 同时执行 UTF-8 字节上限、JSON 和 Schema 校验 |
| resolveFeaturePolicy | 按可信上下文筛选并合并单个 feature |
| decideFeatureAccess | 复验 enabled、紧急关闭、entitlement 和 permission |
| compareSemver | 比较受限 SemVer 与预发布版本 |

## 目录结构

    longhub-feature-policy/
    ├── src/
    │   ├── schema.ts
    │   ├── resolution.ts
    │   └── index.ts
    ├── test/
    │   └── feature-policy.test.ts
    ├── README.md
    └── DESIGN.md

仓库统一使用 test/ 作为 Vitest 用例目录。

## 开发验证

    pnpm --filter @longhub/feature-policy test
    pnpm --filter @longhub/feature-policy typecheck
    pnpm --filter @longhub/feature-policy build

详细的合并语义、信任边界和限制见 [DESIGN.md](DESIGN.md)。
