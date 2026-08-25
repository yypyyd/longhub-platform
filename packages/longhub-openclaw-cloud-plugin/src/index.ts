import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import {
  LONGHUB_CLOUD_PLUGIN_ID,
  LONGHUB_CLOUD_SKILL_TOOL,
} from "./protocol.js";
import {
  cloudSkillParametersSchema,
  createCloudSkillToolFactory,
} from "./tool-factory.js";

/**
 * OpenClaw entry point. No device credential is loaded while the module is
 * loaded; each tool execution reads the current Windows Credential Manager
 * entry and calls Cloud API directly.
 */
// OpenClaw resolves the optional tool again for each runtime context. Keep one
// factory per plugin registration so a redeemed one-time credential survives
// those resolutions while direct execution tokens are still read per call.
const cloudSkillToolFactory = createCloudSkillToolFactory();

const plugin = defineToolPlugin({
  id: LONGHUB_CLOUD_PLUGIN_ID,
  name: "LongHub Cloud Skill",
  description: "把 OpenClaw 的通用云端 Skill 调用安全发送到 LongHub Cloud API。",
  tools: (tool) => [
    tool({
      name: LONGHUB_CLOUD_SKILL_TOOL,
      label: "LongHub 云端 Skill",
      description: "调用已安装且已授权的 LongHub 云端 Skill；业务实现和凭据保留在云端。",
      parameters: cloudSkillParametersSchema,
      optional: true,
      // Keep the context-sensitive factory: OpenClaw supplies the current
      // agent/session/sandbox context for every tool registration.
      factory: ({ toolContext }) => cloudSkillToolFactory(toolContext),
    }),
  ],
});

export * from "./client.js";
export * from "./protocol.js";
export * from "./tool-factory.js";
export default plugin;
