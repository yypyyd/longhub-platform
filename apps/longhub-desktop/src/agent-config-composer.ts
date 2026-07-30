import { isAbsolute, join, relative, resolve } from "node:path";
import { semverGte, type AgentProfile, type PackManifest } from "@longhub/pack-schema";
import type { AgentRegistryEntry } from "./agent-registry.js";

const OPENCLAW_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISOLATION_DENY_TOOLS = [
  "agents_list",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
] as const;

export interface EnabledAgentProfile {
  registry: AgentRegistryEntry;
  manifest: PackManifest;
  profile: AgentProfile;
}

export interface AgentConfigComposerOptions {
  stateDir: string;
  mainWorkspaceDir: string;
  desktopVersion: string;
  openclawVersion: string;
  modelPolicies: Readonly<Record<string, string>>;
  profiles: readonly EnabledAgentProfile[];
  toolBridgePluginPath?: string;
}

export interface OpenClawAgentEntry {
  id: string;
  default?: boolean;
  name: string;
  description?: string;
  workspace: string;
  agentDir: string;
  model: { primary: string };
  skills?: string[];
  identity: { name: string; emoji?: string; avatar?: string };
  memorySearch: { enabled: true; sources: ["memory"] };
  subagents: { allowAgents: []; requireAgentId: true };
  sandbox?: { mode: "all"; scope: "agent"; workspaceAccess: "none" | "ro" | "rw" };
  tools: { allow?: string[]; deny: string[]; elevated: { enabled: false } };
}

function isPathInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function sandboxFor(profile: AgentProfile): OpenClawAgentEntry["sandbox"] {
  const workspaceAccess = {
    strict: "none",
    "workspace-read": "ro",
    "workspace-write": "rw",
  } as const;
  return { mode: "all", scope: "agent", workspaceAccess: workspaceAccess[profile.openclaw.sandbox] };
}

function toolsFor(profile?: AgentProfile): OpenClawAgentEntry["tools"] {
  const profileAllow = profile?.openclaw.tools.allow ?? [];
  const profileDeny = profile?.openclaw.tools.deny ?? [];
  const mandatory = new Set<string>(ISOLATION_DENY_TOOLS);
  const allow = profileAllow.filter((tool) => !mandatory.has(tool)).sort();
  const deny = [...new Set([...profileDeny, ...ISOLATION_DENY_TOOLS])].sort();
  return { ...(allow.length > 0 ? { allow } : {}), deny, elevated: { enabled: false } };
}

function assertComposerOptions(options: AgentConfigComposerOptions): void {
  if (!isAbsolute(options.stateDir) || !isAbsolute(options.mainWorkspaceDir)) {
    throw new Error("OpenClaw stateDir 和 main workspace 必须是绝对路径");
  }
  if (!isPathInside(options.stateDir, options.mainWorkspaceDir)) {
    throw new Error("main workspace 必须位于龙枢 OpenClaw stateDir 内");
  }
  if (options.toolBridgePluginPath && !isAbsolute(options.toolBridgePluginPath)) {
    throw new Error("LongHub Tool Bridge 插件路径必须是绝对路径");
  }
}

function composeProfileAgent(
  source: EnabledAgentProfile,
  options: AgentConfigComposerOptions,
): OpenClawAgentEntry {
  const { profile, registry } = source;
  const { manifest } = source;
  if (!registry.enabled) throw new Error(`Profile ${profile.id} 尚未启用`);
  if (registry.profileId !== profile.id || registry.profileVersion !== profile.version) {
    throw new Error(`Registry 与 Profile 版本不一致: ${profile.id}`);
  }
  if (
    registry.packId !== manifest.pack.id ||
    registry.packVersion !== manifest.pack.version ||
    manifest.agentTemplate.id !== profile.id ||
    manifest.agentTemplate.version !== profile.version
  ) {
    throw new Error(`Registry、Manifest 与 Profile 不一致: ${profile.id}`);
  }
  if (!OPENCLAW_AGENT_ID.test(registry.agentId) || registry.agentId === "main") {
    throw new Error(`Registry agentId 无效: ${registry.agentId}`);
  }
  if (!semverGte(options.desktopVersion, profile.compatibility.minDesktopVersion)) {
    throw new Error(`Profile ${profile.id} 与当前 Desktop 不兼容`);
  }
  if (profile.compatibility.openclawVersion !== options.openclawVersion) {
    throw new Error(`Profile ${profile.id} 与当前 OpenClaw 版本不兼容`);
  }
  const model = options.modelPolicies[profile.modelPolicyId];
  if (!model) throw new Error(`后台未配置模型策略 ${profile.modelPolicyId}`);

  return {
    id: registry.agentId,
    name: profile.display.name,
    ...(profile.display.description ? { description: profile.display.description } : {}),
    workspace: join(options.stateDir, "workspaces", registry.agentId),
    agentDir: join(options.stateDir, "agents", registry.agentId, "agent"),
    model: { primary: model },
    skills: [...profile.openclaw.skills].sort(),
    identity: {
      name: profile.display.name,
      ...(profile.display.emoji ? { emoji: profile.display.emoji } : {}),
    },
    memorySearch: { enabled: true, sources: ["memory"] },
    subagents: { allowAgents: [], requireAgentId: true },
    sandbox: sandboxFor(profile),
    tools: toolsFor(profile),
  };
}

/** 把已启用 Profile 确定性编译为 OpenClaw 2026.7.1-2 的 agents.list。 */
export function composeOpenClawAgentConfig(
  baseConfig: Record<string, unknown>,
  options: AgentConfigComposerOptions,
): Record<string, unknown> {
  assertComposerOptions(options);
  const defaultModel = options.modelPolicies["longhub.model.default"];
  if (!defaultModel) throw new Error("后台未配置 longhub.model.default");

  const profileIds = options.profiles.map((source) => source.profile.id);
  const agentIds = options.profiles.map((source) => source.registry.agentId);
  if (new Set(profileIds).size !== profileIds.length || new Set(agentIds).size !== agentIds.length) {
    throw new Error("启用 Profile 存在重复 ID 或 agentId");
  }

  const mainAgent: OpenClawAgentEntry = {
    id: "main",
    default: true,
    name: "龙枢助手",
    workspace: options.mainWorkspaceDir,
    agentDir: join(options.stateDir, "agents", "main", "agent"),
    model: { primary: defaultModel },
    identity: { name: "龙枢助手", emoji: "🐉", avatar: "avatars/longhub.png" },
    memorySearch: { enabled: true, sources: ["memory"] },
    subagents: { allowAgents: [], requireAgentId: true },
    tools: toolsFor(),
  };
  const profileAgents = [...options.profiles]
    .sort((left, right) => left.registry.agentId.localeCompare(right.registry.agentId, "en"))
    .map((source) => composeProfileAgent(source, options));
  const existingAgents =
    baseConfig.agents && typeof baseConfig.agents === "object" && !Array.isArray(baseConfig.agents)
      ? (baseConfig.agents as Record<string, unknown>)
      : {};
  const existingPlugins =
    baseConfig.plugins && typeof baseConfig.plugins === "object" && !Array.isArray(baseConfig.plugins)
      ? (baseConfig.plugins as Record<string, unknown>)
      : {};
  const existingPluginLoad =
    existingPlugins.load && typeof existingPlugins.load === "object" && !Array.isArray(existingPlugins.load)
      ? (existingPlugins.load as Record<string, unknown>)
      : {};
  const existingPluginEntries =
    existingPlugins.entries && typeof existingPlugins.entries === "object" && !Array.isArray(existingPlugins.entries)
      ? (existingPlugins.entries as Record<string, unknown>)
      : {};
  const existingPluginAllow = Array.isArray(existingPlugins.allow)
    ? existingPlugins.allow.filter((value): value is string => typeof value === "string")
    : [];
  const existingLoadPaths = Array.isArray(existingPluginLoad.paths)
    ? existingPluginLoad.paths.filter((value): value is string => typeof value === "string")
    : [];
  const plugins = options.toolBridgePluginPath
    ? {
        ...existingPlugins,
        enabled: true,
        allow: [...new Set([...existingPluginAllow, "longhub-tool-bridge"])].sort(),
        load: {
          ...existingPluginLoad,
          paths: [...new Set([...existingLoadPaths, options.toolBridgePluginPath])].sort(),
        },
        entries: {
          ...existingPluginEntries,
          "longhub-tool-bridge": { enabled: true },
        },
      }
    : baseConfig.plugins;

  return {
    ...baseConfig,
    ...(plugins ? { plugins } : {}),
    agents: {
      ...existingAgents,
      list: [mainAgent, ...profileAgents],
    },
    tools: {
      ...(baseConfig.tools && typeof baseConfig.tools === "object" && !Array.isArray(baseConfig.tools)
        ? baseConfig.tools
        : {}),
      agentToAgent: { enabled: false, allow: [] },
    },
  };
}
