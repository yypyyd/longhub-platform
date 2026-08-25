import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@longhub/observability";
import type {
  CloudStore,
  HttpRouteLatencyBucket,
  HttpRouteMetricRecord,
  HttpRouteMetricRouteId,
} from "./store.js";

export function httpRouteLatencyBucket(durationMs: number): HttpRouteLatencyBucket {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 200) return "100_to_200ms";
  if (durationMs < 300) return "200_to_300ms";
  if (durationMs < 500) return "300_to_500ms";
  if (durationMs < 800) return "500_to_800ms";
  if (durationMs < 1_000) return "800ms_to_1s";
  if (durationMs < 3_000) return "1_to_3s";
  if (durationMs < 5_000) return "3_to_5s";
  return "gte_5s";
}

export function httpRouteStatusClass(statusCode: number): HttpRouteMetricRecord["status_class"] {
  if (statusCode >= 500) return "5xx";
  if (statusCode >= 400) return "4xx";
  if (statusCode >= 300) return "3xx";
  return "2xx";
}

export function classifiedHttpRoutes(method: string | undefined, pathname: string): HttpRouteMetricRouteId[] {
  if (!pathname.startsWith("/v1/")) return [];
  const routes: HttpRouteMetricRouteId[] = ["cloud_api"];
  if (method === "GET" && pathname === "/v1/health") routes.push("health_probe");
  if (method === "GET" && pathname === "/v1/client/feature-policy") routes.push("client_feature_policy");
  if (method === "GET" && pathname === "/v1/client/runtime-config") routes.push("client_runtime_config");
  if (method === "GET" && pathname === "/v1/client/model-capabilities") routes.push("client_runtime_config");
  if (method === "GET" && pathname === "/v1/catalog/packs") routes.push("skill_catalog");
  if (method === "GET" && (pathname === "/v1/catalog/skills" || /^\/v1\/catalog\/skills\/[^/]+$/u.test(pathname))) {
    routes.push("skill_catalog");
  }
  if (method === "GET" && /^\/v1\/packs\/[^/]+\/download$/u.test(pathname)) routes.push("skill_download");
  if (method === "GET" && /^\/v1\/skills\/[^/]+\/reference$/u.test(pathname)) routes.push("skill_download");
  if (method === "GET" && /^\/v1\/skills\/[^/]+\/adapter$/u.test(pathname)) routes.push("skill_download");
  if (method === "POST" && pathname === "/v1/releases/check") routes.push("skill_release_check");
  return routes;
}

export function observeHttpRoute(
  store: CloudStore,
  logger: StructuredLogger,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  startedAtMs = Date.now(),
): void {
  const routes = classifiedHttpRoutes(req.method, pathname);
  if (routes.length === 0 || pathname === "/v1/admin/metrics") return;
  res.once("finish", () => {
    const finishedAt = Date.now();
    const record = {
      bucket_start: new Date(Math.floor(finishedAt / 3_600_000) * 3_600_000).toISOString(),
      status_class: httpRouteStatusClass(res.statusCode),
      latency_bucket: httpRouteLatencyBucket(Math.max(0, finishedAt - startedAtMs)),
      count: 1,
    } as const;
    void store.incrementHttpRouteMetrics(routes.map((route_id) => ({ ...record, route_id })))
      .catch(() => logger.warn("http_route.metrics_dropped", { route_count: routes.length }));
  });
}
