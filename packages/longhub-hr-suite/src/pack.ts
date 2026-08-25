/**
 * HR 套装制品源：供 Console 上传发布（integrity 由云端签名时重算填充）。
 */
import { SDK_VERSION } from "@longhub/sdk";
import type { AgentProfile, PackManifest } from "@longhub/pack-schema";
import { HR_AGENT_ID } from "./agent-skill.js";
import { offerLetter, resumeScreen } from "./skills.js";

export const HR_PACK_ID = "longhub.hr-suite";

export interface HrPackSource {
  manifest: PackManifest;
  files: Record<string, string>;
}

export const HR_PROFILE_PATH = "agent-profile.json";

/** 生成受签名保护的 HR Agent Profile。 */
export function buildHrAgentProfile(): AgentProfile {
  const permissions = [...new Set([...resumeScreen.permissions, ...offerLetter.permissions])];
  return {
    schemaVersion: "longhub/agent-profile/v1",
    id: HR_AGENT_ID,
    version: "1.0.0",
    display: {
      name: "HR 助理",
      description: "协助完成 JD 起草、简历初筛和录用通知书等招聘工作。",
      emoji: "🦞",
      category: "人力资源",
      starterPrompts: [
        "帮我起草一份前端工程师 JD",
        "根据岗位要求初筛这份简历",
        "生成一份录用通知书",
      ],
    },
    workspace: {
      identity: "workspace/IDENTITY.md",
      soul: "workspace/SOUL.md",
      agents: "workspace/AGENTS.md",
      user: "workspace/USER.md",
    },
    capabilities: [
      {
        id: "longhub.capability.recruitment",
        skillIds: [
          resumeScreen.id,
          offerLetter.id,
          "longhub.skill.jd-draft",
          "longhub.skill.salary-band",
        ],
        permissions,
      },
    ],
    openclaw: {
      skills: [
        resumeScreen.id,
        offerLetter.id,
        "longhub.skill.jd-draft",
        "longhub.skill.salary-band",
      ],
      tools: {
        // LH-036-04 先开放只读简历初筛；写操作和 L2/云端能力待权限交集闭环后启用。
        allow: ["longhub_offer_letter", "longhub_resume_screen"],
        deny: [],
      },
      sandbox: "workspace-write",
    },
    memory: { mode: "isolated" },
    lifecycle: {
      defaultSessionTitle: "HR 新会话",
      entitlementExpiryPolicy: "readonly",
    },
    compatibility: {
      minManagerVersion: "0.3.6",
      openclawVersion: "2026.7.1-2",
      profileMigrationVersion: 1,
    },
    modelPolicyId: "longhub.model.default",
  };
}

/** 生成 HR 套装上传源（manifest + files） */
export function buildHrPackSource(version: string): HrPackSource {
  const profile = buildHrAgentProfile();
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: HR_PACK_ID, version, minManagerVersion: "0.3.6" },
    agentTemplate: { id: HR_AGENT_ID, version: profile.version, profilePath: HR_PROFILE_PATH },
    capabilities: [
      {
        id: "longhub.capability.recruitment",
        version: "1.0.0",
        required: true,
        permissions: [...resumeScreen.permissions, ...offerLetter.permissions],
      },
    ],
    runtime: { sdkVersion: SDK_VERSION, executionMode: "hybrid" },
    limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
    integrity: { algorithm: "sha256", digest: "unsigned", signatureKeyId: "unsigned" },
  };
  const files: Record<string, string> = {
    [HR_PROFILE_PATH]: JSON.stringify(profile, null, 2),
    "workspace/IDENTITY.md": "# HR 助理\n\n你是龙枢 HR 助理。",
    "workspace/SOUL.md": "专注招聘业务，准确、审慎地处理候选人信息；写操作必须经过用户确认。",
    "workspace/AGENTS.md": "只使用当前 HR Profile 允许的工具，不读取其他智能体的工作区或会话。",
    "workspace/USER.md": "用户偏好由当前智能体独立维护，不与其他智能体共享。",
    "README.md": `# HR 套装 v${version}\n\n简历初筛、录用通知书生成、JD 起草（OpenClaw 底座）、薪酬带宽（云端）。`,
  };
  return { manifest, files };
}
