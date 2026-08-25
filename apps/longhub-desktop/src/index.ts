import { CORE_RPC_VERSION, HARD_LIMITS } from "@longhub/core";

export * from "./agent-config-composer.js";
export * from "./agent-install-navigation.js";
export * from "./agent-runtime-activation.js";
export * from "./activation-window.js";
export * from "./activation-code-input.js";
export * from "./agent-registry.js";
export * from "./skill-registry.js";
export * from "./skill-runtime-policy.js";
export * from "./skill-lifecycle-coordinator.js";
export * from "./skill-catalog-client.js";
export * from "./skill-center-service.js";
export * from "./skill-trust-policy.js";
export * from "./session-management.js";
export * from "./file-capability.js";
export * from "./isolated-file-parser.js";
export * from "./knowledge-client.js";
export * from "./local-personal-profile.js";
export * from "./model-input-capabilities.js";
export * from "./nocode-agent-overlay.js";
export * from "./agent-handoff.js";
export * from "./nocode-workspace-service.js";
export * from "./openclaw-content-importer.js";
export * from "./user-data-center-service.js";
export * from "./agent-lifecycle-coordinator.js";
export * from "./agent-management-service.js";
export * from "./agent-pack-catalog.js";
export * from "./device-credential-store.js";
export * from "./windows-credential-manager.js";
export * from "./openclaw-gateway-client.js";
export * from "./gateway-runtime-recovery.js";
export * from "./openclaw-product-ui.js";
export * from "./openclaw-selector-policy.js";
export * from "./pack-eligibility.js";
export * from "./client-update.js";
export * from "./product-error-page.js";
export * from "./runtime-config-resolver.js";
export * from "./feature-policy-coordinator.js";
export * from "./product-extension-entry.js";
export * from "./product-extension-window.js";
export * from "./diagnostic-export.js";
export * from "./storage-maintenance.js";

export function desktopInfo(): string {
  return `LongHub Desktop (Core RPC ${CORE_RPC_VERSION}, depth<=${HARD_LIMITS.maxTaskDepth})`;
}
