import { createConsoleLogger } from "@longhub/observability";
import { createCloudApiServer } from "./server.js";
import { MemoryStore } from "./memory-store.js";
import { PgStore } from "./pg-store.js";

export { createCloudApiServer, generateSigningKey, type SigningKey } from "./server.js";
export { MemoryStore } from "./memory-store.js";
export { PgStore } from "./pg-store.js";
export type {
  CloudStore,
  CloudTask,
  CloudTaskEvent,
  CloudTaskStatus,
  DeviceRecord,
  EntitlementRecord,
  PackReleaseRecord,
} from "./store.js";

/** 控制面模块清单：Identity/Agent Catalog/Entitlement/Release/Artifact/Task/Execution/Model Gateway/Audit */
export const CONTROL_PLANE_MODULES = [
  "identity",
  "agent-catalog",
  "entitlement",
  "release",
  "artifact",
  "task",
  "execution",
  "model-gateway",
  "audit",
] as const;

/** DATABASE_URL 存在时使用 PostgreSQL 持久化，否则用内存存储（仅限本地原型） */
export async function bootstrap(
  port = Number(process.env.PORT ?? 8081),
  executorUrl = process.env.EXECUTOR_URL ?? "http://127.0.0.1:8082",
): Promise<void> {
  const logger = createConsoleLogger("cloud-api");
  const databaseUrl = process.env.DATABASE_URL;
  let store;
  if (databaseUrl) {
    const pgStore = new PgStore(databaseUrl);
    await pgStore.init();
    store = pgStore;
  } else {
    logger.warn("store.memory", { reason: "未配置 DATABASE_URL，任务与设备数据不持久化" });
    store = new MemoryStore();
  }
  createCloudApiServer({ executorUrl, store, adminToken: process.env.ADMIN_TOKEN }).listen(port, () =>
    logger.info("listening", {
      port,
      executorUrl,
      persistent: Boolean(databaseUrl),
      modules: CONTROL_PLANE_MODULES.length,
    }),
  );
}
