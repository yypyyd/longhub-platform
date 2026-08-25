import { randomUUID } from "node:crypto";

export interface UserContentSkill {
  readonly schemaVersion: "longhub/user-content-skill/v1";
  readonly source: "user_local" | "openclaw_import";
  readonly skill: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly instructions: string;
  readonly examples: readonly string[];
  readonly permissions: readonly [];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

export function parseUserContentSkill(input: unknown): UserContentSkill {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
    !exactKeys(input, ["schemaVersion", "source", "skill", "instructions", "examples", "permissions"])) {
    throw new Error("用户 Content Skill 格式无效");
  }
  const raw = input as Record<string, unknown>;
  const skill = raw.skill;
  if (raw.schemaVersion !== "longhub/user-content-skill/v1" ||
    (raw.source !== "user_local" && raw.source !== "openclaw_import") ||
    !skill || typeof skill !== "object" || Array.isArray(skill) ||
    !exactKeys(skill, ["id", "name", "description"]) ||
    typeof (skill as Record<string, unknown>).id !== "string" ||
    !/^user\.skill\.[0-9a-f-]{36}$/i.test((skill as { id: string }).id) ||
    typeof (skill as Record<string, unknown>).name !== "string" || !(skill as { name: string }).name.trim() ||
    (skill as { name: string }).name.length > 80 ||
    typeof (skill as Record<string, unknown>).description !== "string" ||
    (skill as { description: string }).description.length > 500 ||
    typeof raw.instructions !== "string" || !raw.instructions.trim() || Buffer.byteLength(raw.instructions) > 256 * 1024 ||
    !Array.isArray(raw.examples) || raw.examples.length > 10 ||
    raw.examples.some((item) => typeof item !== "string" || !item.trim() || item.length > 300) ||
    !Array.isArray(raw.permissions) || raw.permissions.length !== 0) {
    throw new Error("用户 Content Skill 字段无效");
  }
  const forbidden = /(?:<script\b|javascript:|powershell|child_process|\beval\s*\(|\bexec\s*\(|mcpServers?|pluginPath|https?:\/\/)/iu;
  if (forbidden.test(raw.instructions)) throw new Error("用户 Content Skill 包含可执行或远程加载内容");
  return structuredClone(input) as UserContentSkill;
}

export function createUserContentSkill(input: {
  name: string;
  description?: string;
  instructions: string;
  examples?: readonly string[];
  source?: UserContentSkill["source"];
}): UserContentSkill {
  return parseUserContentSkill({
    schemaVersion: "longhub/user-content-skill/v1",
    source: input.source ?? "user_local",
    skill: { id: `user.skill.${randomUUID()}`, name: input.name, description: input.description ?? "" },
    instructions: input.instructions,
    examples: [...(input.examples ?? [])],
    permissions: [],
  });
}

export function exportUserContentSkill(skill: UserContentSkill): string {
  return `${JSON.stringify(parseUserContentSkill(skill), null, 2)}\n`;
}

/** 导入始终创建新的 user.* 身份，不能继承伪造的官方发布方或平台签名。 */
export function importUserContentSkill(serialized: string): UserContentSkill {
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new Error("用户 Content Skill 导入包过大");
  const parsed = parseUserContentSkill(JSON.parse(serialized) as unknown);
  return createUserContentSkill({
    name: parsed.skill.name,
    description: parsed.skill.description,
    instructions: parsed.instructions,
    examples: parsed.examples,
    source: parsed.source,
  });
}
