/**
 * Executor production process entrypoint.
 *
 * The Cloud Skill registry is imported from this server-only artifact and is
 * never selected by a request, a page, or an environment-provided module path.
 */
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { bootstrapExecutorServer, type CloudSkill } from "./server.js";
import { PRIVATE_CLOUD_SKILL_REGISTRY } from "./private-skills/registry.js";

export interface ProductionExecutorBootstrapConfig {
  readonly skills: ReadonlyMap<string, CloudSkill>;
}

/** Pure production wiring surface used by startup and its regression test. */
export function productionExecutorBootstrapConfig(): ProductionExecutorBootstrapConfig {
  return Object.freeze({ skills: PRIVATE_CLOUD_SKILL_REGISTRY });
}

export function startProductionExecutor(): Server {
  const { skills } = productionExecutorBootstrapConfig();
  return bootstrapExecutorServer(undefined, undefined, undefined, skills);
}

// Keep imports side-effect free for tests while preserving `node dist/main.js`.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  startProductionExecutor();
}
