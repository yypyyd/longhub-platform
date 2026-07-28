import { createConsoleLogger } from "@longhub/observability";
import { createExecutorServer } from "./server.js";

export { createExecutorServer } from "./server.js";

export function bootstrap(port = Number(process.env.PORT ?? 8082)): void {
  const logger = createConsoleLogger("executor");
  createExecutorServer().listen(port, () => logger.info("listening", { port }));
}
