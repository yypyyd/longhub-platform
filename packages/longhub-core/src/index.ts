/** 龙枢内核对外入口。会话、任务 DAG、能力路由、权限与预算控制在阶段 0 逐步落地。 */
export const CORE_RPC_VERSION = "1.0";

export interface CoreBudget {
  maxTokens: number;
  maxCostCents: number;
  maxDurationMs: number;
}

export interface TaskNode {
  id: string;
  kind: "skill" | "agent" | "aggregate";
  dependsOn: string[];
}

/** 硬限制：最大协作深度 3，默认并发 3 */
export const HARD_LIMITS = {
  maxTaskDepth: 3,
  defaultConcurrency: 3,
} as const;

export * from "./rpc.js";
export * from "./runtime.js";
