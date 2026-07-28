/**
 * HR 套装制品源：供 Console 上传发布（integrity 由云端签名时重算填充）。
 */
import { SDK_VERSION } from "@longhub/sdk";
import type { PackManifest } from "@longhub/pack-schema";
import { HR_AGENT_ID } from "./agent-skill.js";
import { offerLetter, resumeScreen } from "./skills.js";

export const HR_PACK_ID = "longhub.hr-suite";

export interface HrPackSource {
  manifest: PackManifest;
  files: Record<string, string>;
}

/** 生成 HR 套装上传源（manifest + files） */
export function buildHrPackSource(version: string): HrPackSource {
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: HR_PACK_ID, version, minDesktopVersion: "1.0.0" },
    agentTemplate: { id: HR_AGENT_ID, version: "1.0.0" },
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
    "agent.yaml": [
      `id: ${HR_AGENT_ID}`,
      `name: HR 助理`,
      `skills:`,
      `  - ${resumeScreen.id}`,
      `  - ${offerLetter.id}`,
      `  - longhub.skill.jd-draft`,
      `  - longhub.skill.salary-band # 云端受保护技能（L3）`,
    ].join("\n"),
    "README.md": `# HR 套装 v${version}\n\n简历初筛、录用通知书生成、JD 起草（OpenClaw 底座）、薪酬带宽（云端）。`,
  };
  return { manifest, files };
}
