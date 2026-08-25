// Stable package-root entry keeps OpenClaw's manifest and runtime entry under the same trust root.
import { createLongHubBridgeClientFromEnv } from "./dist/client.js";
import {
  LONGHUB_BRIDGE_PLUGIN_ID,
  LONGHUB_OFFER_LETTER_TOOL,
  LONGHUB_RESUME_SCREEN_TOOL,
} from "./dist/protocol.js";
import {
  createLongHubToolFactory,
  createOfferLetterToolFactory,
} from "./dist/tool-factory.js";

export * from "./dist/client.js";
export * from "./dist/protocol.js";
export * from "./dist/tool-factory.js";

const bridgeClient = createLongHubBridgeClientFromEnv();

export default {
  id: LONGHUB_BRIDGE_PLUGIN_ID,
  name: "LongHub Tool Bridge",
  description: "将 OpenClaw 原生工具调用安全转发到 LongHub Core。",
  register(api) {
    api.registerTool(
      (toolContext) => createLongHubToolFactory(bridgeClient)(toolContext),
      { name: LONGHUB_RESUME_SCREEN_TOOL, optional: true },
    );
    api.registerTool(
      (toolContext) => createOfferLetterToolFactory(bridgeClient)(toolContext),
      { name: LONGHUB_OFFER_LETTER_TOOL, optional: true },
    );
  },
};
