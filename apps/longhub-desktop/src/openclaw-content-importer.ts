import { createUserContentSkill, type UserContentSkill } from "@longhub/pack-schema";
import { isAbsolute, posix } from "node:path";

const ALLOWED = /\.(?:md|json|png|jpe?g)$/i;
const FORBIDDEN_TEXT = /(?:<script\b|javascript:|https?:\/\/|\b(?:eval|exec)\s*\(|powershell|child_process|mcpServers?|pluginPath|native|executable)/iu;

function safeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) safeJson(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:script|scripts|command|url|plugin|plugins|mcp|mcpServers|executable|native)$/i.test(key)) {
      throw new Error("OpenClaw 导入包含可执行、插件、MCP 或远程引用");
    }
    safeJson(item);
  }
}

/** 将可证明为纯内容的 OpenClaw Skill 降权为新的 user Content Skill。 */
export function importOpenClawContentSkill(files: Readonly<Record<string, string | Uint8Array>>): UserContentSkill {
  const entries = Object.entries(files);
  if (entries.length < 1 || entries.length > 64) throw new Error("OpenClaw Skill 文件数量无效");
  let total = 0;
  let instructions: string | undefined;
  for (const [rawPath, rawContent] of entries) {
    const path = rawPath.replaceAll("\\", "/");
    const normalized = posix.normalize(path);
    if (isAbsolute(path) || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../") ||
      !ALLOWED.test(normalized) || /(?:^|\/)(?:package\.json|openclaw\.plugin\.json)$/i.test(normalized)) {
      throw new Error("OpenClaw 导入包含越界路径、脚本或插件文件");
    }
    const content = typeof rawContent === "string" ? Buffer.from(rawContent) : Buffer.from(rawContent);
    total += content.length;
    if (total > 2 * 1024 * 1024) throw new Error("OpenClaw Skill 导入包过大");
    if (/\.(?:png|jpe?g)$/i.test(normalized)) {
      const png = content.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
      const jpeg = content[0] === 0xff && content[1] === 0xd8 && content.at(-2) === 0xff && content.at(-1) === 0xd9;
      if (!png && !jpeg) throw new Error("OpenClaw 静态资源扩展名与内容不符");
      continue;
    }
    if (content.includes(0)) throw new Error("OpenClaw 文本文件包含二进制内容");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (FORBIDDEN_TEXT.test(text)) throw new Error("OpenClaw 内容包含可执行或远程加载声明");
    if (normalized.toLowerCase().endsWith(".json")) safeJson(JSON.parse(text) as unknown);
    if (normalized.toLowerCase() === "skill.md") instructions = text;
  }
  if (!instructions?.trim()) throw new Error("OpenClaw Content Skill 缺少 SKILL.md");
  const heading = instructions.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return createUserContentSkill({
    name: heading?.slice(0, 80) || "导入的 OpenClaw 内容能力",
    description: "从纯内容 OpenClaw Skill 降权导入",
    instructions,
    source: "openclaw_import",
  });
}
