import { z } from "zod";
import {
  agentProfileSchema,
  packRelativePathSchema,
  type AgentProfile,
} from "./agent-profile.js";
import { packManifestSchema, type PackManifest } from "./manifest.js";

export interface ProfileValidationIssue {
  path: string;
  message: string;
}

export type AgentProfileValidationResult =
  | { ok: true; profile: AgentProfile }
  | { ok: false; issues: ProfileValidationIssue[] };

export type PackContentValidationResult =
  | { ok: true; manifest: PackManifest; profile: AgentProfile }
  | { ok: false; issues: ProfileValidationIssue[] };

function issuesFromZod(error: z.ZodError, prefix = ""): ProfileValidationIssue[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path].filter(Boolean).join("."),
    message: issue.message,
  }));
}

/** 校验一个已解析的 Agent Profile V1。 */
export function validateAgentProfile(input: unknown): AgentProfileValidationResult {
  const parsed = agentProfileSchema.safeParse(input);
  return parsed.success
    ? { ok: true, profile: parsed.data }
    : { ok: false, issues: issuesFromZod(parsed.error) };
}

function parseProfileFile(profilePath: string, content: string): AgentProfileValidationResult {
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return {
      ok: false,
      issues: [{ path: `files.${profilePath}`, message: "Agent Profile 不是合法 JSON" }],
    };
  }
  const validated = validateAgentProfile(input);
  if (validated.ok) return validated;
  return {
    ok: false,
    issues: validated.issues.map((issue) => ({
      path: `files.${profilePath}.${issue.path}`,
      message: issue.message,
    })),
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/**
 * 联合校验 Manifest、Pack 文件和 Agent Profile 的引用与权限边界。
 * 所有引用文件必须存在；Profile ID/version/capabilities/permissions 必须与 Manifest 一致。
 */
export function validatePackContent(
  manifestInput: unknown,
  filesInput: unknown,
): PackContentValidationResult {
  const manifestParsed = packManifestSchema.safeParse(manifestInput);
  if (!manifestParsed.success) {
    return { ok: false, issues: issuesFromZod(manifestParsed.error, "manifest") };
  }
  const filesParsed = z.record(z.string()).safeParse(filesInput);
  if (!filesParsed.success) {
    return { ok: false, issues: issuesFromZod(filesParsed.error, "files") };
  }

  const manifest = manifestParsed.data;
  const files = filesParsed.data;
  const issues: ProfileValidationIssue[] = [];

  for (const path of Object.keys(files)) {
    const parsedPath = packRelativePathSchema.safeParse(path);
    if (!parsedPath.success) {
      issues.push({ path: `files.${path}`, message: "Pack 文件路径不安全" });
    }
  }

  const profilePath = manifest.agentTemplate.profilePath;
  const profileContent = files[profilePath];
  if (profileContent === undefined) {
    issues.push({ path: `files.${profilePath}`, message: "缺少 Manifest 引用的 Agent Profile" });
    return { ok: false, issues };
  }

  const profileResult = parseProfileFile(profilePath, profileContent);
  if (!profileResult.ok) return { ok: false, issues: [...issues, ...profileResult.issues] };
  const profile = profileResult.profile;

  if (profile.id !== manifest.agentTemplate.id) {
    issues.push({ path: `files.${profilePath}.id`, message: "Profile ID 必须与 agentTemplate.id 一致" });
  }
  if (profile.version !== manifest.agentTemplate.version) {
    issues.push({ path: `files.${profilePath}.version`, message: "Profile 版本必须与 agentTemplate.version 一致" });
  }
  if (profile.compatibility.minDesktopVersion !== manifest.pack.minDesktopVersion) {
    issues.push({
      path: `files.${profilePath}.compatibility.minDesktopVersion`,
      message: "Profile 与 Pack 的最低 Desktop 版本必须一致",
    });
  }

  const manifestCapabilities = new Map(manifest.capabilities.map((capability) => [capability.id, capability]));
  if (manifestCapabilities.size !== manifest.capabilities.length) {
    issues.push({ path: "manifest.capabilities", message: "能力 ID 不得重复" });
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitCapability = (id: string): void => {
    if (visiting.has(id)) {
      issues.push({ path: `manifest.capabilities.${id}.dependsOn`, message: "能力依赖不得形成循环" });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const capability = manifestCapabilities.get(id);
    for (const dependency of capability?.dependsOn ?? []) {
      if (!manifestCapabilities.has(dependency)) {
        issues.push({ path: `manifest.capabilities.${id}.dependsOn`, message: `缺少依赖能力 ${dependency}` });
      } else {
        visitCapability(dependency);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const capability of manifest.capabilities) visitCapability(capability.id);
  const profileCapabilities = new Map(profile.capabilities.map((capability) => [capability.id, capability]));
  for (const capability of manifest.capabilities) {
    const mapped = profileCapabilities.get(capability.id);
    if (capability.required && !mapped) {
      issues.push({ path: `files.${profilePath}.capabilities`, message: `缺少必需能力 ${capability.id}` });
    }
    if (mapped && !sameStringSet(mapped.permissions, capability.permissions)) {
      issues.push({
        path: `files.${profilePath}.capabilities.${capability.id}.permissions`,
        message: "Profile 权限必须与 Manifest 能力权限完全一致",
      });
    }
  }
  for (const capability of profile.capabilities) {
    if (!manifestCapabilities.has(capability.id)) {
      issues.push({
        path: `files.${profilePath}.capabilities.${capability.id}`,
        message: "Profile 引用了 Manifest 未声明的能力",
      });
    }
  }

  const referencedFiles = [
    profile.display.avatar,
    profile.workspace.identity,
    profile.workspace.soul,
    profile.workspace.agents,
    profile.workspace.user,
  ].filter((path): path is string => path !== undefined);
  for (const path of referencedFiles) {
    if (files[path] === undefined) {
      issues.push({ path: `files.${profilePath}`, message: `缺少 Profile 引用文件 ${path}` });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, manifest, profile };
}
