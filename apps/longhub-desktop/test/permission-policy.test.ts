import { describe, expect, it } from "vitest";
import { permissionsRequiringConfirmation } from "../src/permission-policy.js";

describe("权限确认策略", () => {
  it("读类权限免确认", () => {
    expect(
      permissionsRequiringConfirmation([
        "connector:hr-api:read",
        "fs:workspace:list",
        "connector:hr-api:query",
      ]),
    ).toEqual([]);
  });

  it("写、发送、删除、支付类权限需要确认", () => {
    expect(
      permissionsRequiringConfirmation([
        "connector:hr-api:read",
        "connector:hr-api:write",
        "fs:workspace:delete",
        "message:im:send",
        "payment:corp-account:pay",
      ]),
    ).toEqual([
      "connector:hr-api:write",
      "fs:workspace:delete",
      "message:im:send",
      "payment:corp-account:pay",
    ]);
  });

  it("无动作段的权限按需确认处理", () => {
    expect(permissionsRequiringConfirmation(["connector:hr-api"])).toEqual([
      "connector:hr-api",
    ]);
  });
});
