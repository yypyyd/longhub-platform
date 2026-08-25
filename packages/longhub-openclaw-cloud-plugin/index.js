// Stable package-root entry keeps the OpenClaw manifest and runtime entry under
// the same trust root while TypeScript sources remain outside the distribution.
import plugin from "./dist/index.js";

export * from "./dist/index.js";
export default plugin;
