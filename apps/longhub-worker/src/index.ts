import { createConsoleLogger } from "@longhub/observability";

export function bootstrap(): void {
  createConsoleLogger("worker").info("bootstrap");
}
