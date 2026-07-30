import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatePackContent, type AgentProfile } from "@longhub/pack-schema";
export { BUNDLED_OPENCLAW_VERSION } from "@longhub/openclaw-compat";
import type { EnabledAgentProfile } from "./agent-config-composer.js";
import { AgentRegistry } from "./agent-registry.js";
import { PackInstaller } from "./pack-installer.js";

export interface AgentRuntimeActivationOptions {
  installer: PackInstaller;
  registry: AgentRegistry;
  stateDir: string;
}

const WORKSPACE_TARGETS = {
  identity: "IDENTITY.md",
  soul: "SOUL.md",
  agents: "AGENTS.md",
  user: "USER.md",
} as const;

function writeWorkspaceFile(path: string, content: string, preserveExisting: boolean): void {
  if (existsSync(path)) {
    if (preserveExisting || readFileSync(path, "utf8") === content) return;
  }
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

/**
 * 将受签名 Pack 中的受控模板落到目标 agent 的独立 workspace。
 * IDENTITY/SOUL/AGENTS 属于 Pack 管理文件；USER 只做首次初始化，避免覆盖后续用户偏好。
 */
export function materializeAgentWorkspace(
  stateDir: string,
  agentId: string,
  profile: AgentProfile,
  files: Readonly<Record<string, string>>,
): string {
  const workspaceDir = join(stateDir, "workspaces", agentId);
  mkdirSync(workspaceDir, { recursive: true });

  for (const [profileKey, targetName] of Object.entries(WORKSPACE_TARGETS) as Array<
    [keyof typeof WORKSPACE_TARGETS, string]
  >) {
    const sourcePath = profile.workspace[profileKey];
    if (!sourcePath) continue;
    const content = files[sourcePath];
    if (content === undefined) throw new Error(`Profile ${profile.id} 缺少 workspace 模板 ${sourcePath}`);
    writeWorkspaceFile(join(workspaceDir, targetName), content, profileKey === "user");
  }

  // OpenClaw 的 agent 配置与 session store 均按 agentId 隔离；提前创建便于权限和路径验收。
  mkdirSync(join(stateDir, "agents", agentId, "agent"), { recursive: true });
  mkdirSync(join(stateDir, "agents", agentId, "sessions"), { recursive: true });
  return workspaceDir;
}

/** 从 PackInstaller 当前 active 指针构建本次 Gateway 启动应启用的 Profile 集合。 */
export function activateInstalledAgentProfiles(
  options: AgentRuntimeActivationOptions,
): EnabledAgentProfile[] {
  const enabled: EnabledAgentProfile[] = [];
  const installed = [...options.installer.listInstalled()]
    .filter((pack) => pack.activeVersion !== undefined)
    .sort((left, right) => left.packId.localeCompare(right.packId, "en"));

  for (const installedPack of installed) {
    const pack = options.installer.readActivePack(installedPack.packId);
    if (!pack) continue;
    const validated = validatePackContent(pack.manifest, pack.files);
    if (!validated.ok) {
      throw new Error(
        `Pack ${installedPack.packId} 激活校验失败: ${validated.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const registry = options.registry.register({ manifest: validated.manifest, files: pack.files });
    if (!registry.enabled) continue;
    materializeAgentWorkspace(options.stateDir, registry.agentId, validated.profile, pack.files);
    enabled.push({ registry, manifest: validated.manifest, profile: validated.profile });
  }

  return enabled;
}
