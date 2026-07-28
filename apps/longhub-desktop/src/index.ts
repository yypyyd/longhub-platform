import { CORE_RPC_VERSION, HARD_LIMITS } from "@longhub/core";

export function desktopInfo(): string {
  return `LongHub Desktop (Core RPC ${CORE_RPC_VERSION}, depth<=${HARD_LIMITS.maxTaskDepth})`;
}
