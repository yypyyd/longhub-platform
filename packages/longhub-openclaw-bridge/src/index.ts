import {
  defineToolPlugin,
  type DefinedToolPluginEntry,
} from "openclaw/plugin-sdk/tool-plugin";
import { createLongHubBridgeClientFromEnv } from "./client.js";
import { LONGHUB_BRIDGE_PLUGIN_ID, LONGHUB_RESUME_SCREEN_TOOL } from "./protocol.js";
import { createLongHubToolFactory, resumeScreenParameters } from "./tool-factory.js";

export * from "./client.js";
export * from "./protocol.js";
export * from "./tool-factory.js";

const bridgeClient = createLongHubBridgeClientFromEnv();

const longHubToolBridgePlugin: DefinedToolPluginEntry = defineToolPlugin({
  id: LONGHUB_BRIDGE_PLUGIN_ID,
  name: "LongHub Tool Bridge",
  description: "将 OpenClaw 原生工具调用安全转发到 LongHub Core。",
  tools: (tool) => [
    tool({
      name: LONGHUB_RESUME_SCREEN_TOOL,
      label: "简历初筛",
      description: "按照岗位必备关键词对候选人简历进行初筛并给出命中率和建议。",
      parameters: resumeScreenParameters,
      optional: true,
      factory({ toolContext }) {
        return createLongHubToolFactory(bridgeClient)(toolContext);
      },
    }),
  ],
});

export default longHubToolBridgePlugin;
