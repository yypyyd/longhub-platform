import { describe, expect, it } from "vitest";
import {
  classifiedHttpRoutes,
  httpRouteLatencyBucket,
  httpRouteStatusClass,
} from "../src/http-route-metrics.js";

describe("固定路由 HTTP SLO 聚合", () => {
  it("只输出固定低基数 route ID，不保存查询参数或动态 pack ID", () => {
    expect(classifiedHttpRoutes("GET", "/v1/client/feature-policy")).toEqual([
      "cloud_api",
      "client_feature_policy",
    ]);
    expect(classifiedHttpRoutes("GET", "/v1/packs/longhub.hr-suite/download")).toEqual([
      "cloud_api",
      "skill_download",
    ]);
    expect(classifiedHttpRoutes("GET", "/admin/")).toEqual([]);
  });

  it("延迟桶覆盖 300/800/3000/5000ms SLO 边界", () => {
    expect([99, 100, 299, 300, 799, 800, 2_999, 3_000, 4_999, 5_000].map(httpRouteLatencyBucket))
      .toEqual([
        "lt_100ms",
        "100_to_200ms",
        "200_to_300ms",
        "300_to_500ms",
        "500_to_800ms",
        "800ms_to_1s",
        "1_to_3s",
        "3_to_5s",
        "3_to_5s",
        "gte_5s",
      ]);
    expect([200, 304, 429, 503].map(httpRouteStatusClass)).toEqual(["2xx", "3xx", "4xx", "5xx"]);
  });
});
