/**
 * 小龙虾适配层：龙枢业务不直接依赖上游内部类型（ADR-LH-009）。
 */

/** 上游基线（阶段 0 审计结论） */
export const UPSTREAM = {
  /** “小龙虾”即 OpenClaw（社区昵称） */
  repository: "https://github.com/openclaw/openclaw",
  baselineVersion: "2026.7.2",
  license: "MIT",
  /** 上游要求 Node >=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0 */
  nodeEngines: ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0",
} as const;

export * from "./adapter.js";
export * from "./mock-adapter.js";
export * from "./openclaw-adapter.js";
