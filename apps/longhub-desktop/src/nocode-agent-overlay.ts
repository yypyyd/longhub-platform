import { randomUUID } from "node:crypto";

export interface NoCodeAgentOverlay {
  readonly schemaVersion: "longhub/nocode-agent-overlay/v1";
  readonly overlayId: string;
  readonly baseProfileId: string;
  readonly targetAgentId: string;
  readonly name: string;
  readonly description: string;
  readonly preferences: {
    readonly language: "zh-CN" | "en-US";
    readonly tone: "concise" | "balanced" | "detailed";
  };
  readonly personalEntryIds: readonly string[];
  readonly skillIds: readonly string[];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export function parseNoCodeAgentOverlay(input: unknown): NoCodeAgentOverlay {
  if (!input || typeof input !== "object" || Array.isArray(input) || !exactKeys(input, [
    "schemaVersion", "overlayId", "baseProfileId", "targetAgentId", "name", "description", "preferences",
    "personalEntryIds", "skillIds",
  ])) throw new Error("无代码 Agent 覆盖层格式无效");
  const raw = input as Record<string, unknown>;
  const preferences = raw.preferences;
  if (raw.schemaVersion !== "longhub/nocode-agent-overlay/v1" || typeof raw.overlayId !== "string" ||
    !/^user\.agent\.[0-9a-f-]{36}$/i.test(raw.overlayId) || typeof raw.baseProfileId !== "string" ||
    !ID.test(raw.baseProfileId) || typeof raw.targetAgentId !== "string" || !ID.test(raw.targetAgentId) ||
    typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80 ||
    typeof raw.description !== "string" || raw.description.length > 500 || !preferences ||
    typeof preferences !== "object" || Array.isArray(preferences) || !exactKeys(preferences, ["language", "tone"]) ||
    !["zh-CN", "en-US"].includes(String((preferences as Record<string, unknown>).language)) ||
    !["concise", "balanced", "detailed"].includes(String((preferences as Record<string, unknown>).tone)) ||
    !Array.isArray(raw.personalEntryIds) || raw.personalEntryIds.length > 32 ||
    raw.personalEntryIds.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(raw.personalEntryIds).size !== raw.personalEntryIds.length ||
    !Array.isArray(raw.skillIds) || raw.skillIds.length > 32 ||
    raw.skillIds.some((id) => typeof id !== "string" || !ID.test(id)) || new Set(raw.skillIds).size !== raw.skillIds.length) {
    throw new Error("无代码 Agent 覆盖层字段无效");
  }
  return structuredClone(input) as NoCodeAgentOverlay;
}

export function createNoCodeAgentOverlay(input: Omit<NoCodeAgentOverlay, "schemaVersion" | "overlayId">): NoCodeAgentOverlay {
  return parseNoCodeAgentOverlay({
    schemaVersion: "longhub/nocode-agent-overlay/v1",
    overlayId: `user.agent.${randomUUID()}`,
    ...input,
  });
}

/** 只生成用户提示覆盖，不修改签名 Profile，也不返回模型、Gateway、plugin/tool 权限字段。 */
export function composeNoCodeAgentPrompt(overlay: NoCodeAgentOverlay): string {
  const value = parseNoCodeAgentOverlay(overlay);
  return [
    `# ${value.name}`,
    value.description,
    `回复语言：${value.preferences.language}`,
    `表达风格：${value.preferences.tone}`,
  ].filter(Boolean).join("\n");
}
