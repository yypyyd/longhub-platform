/** 账号（注册/登录/会话）、管理员（RBAC/审计）、计费（商品/订单/钱包/授权发放）模块测试。 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth.js";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin-token";

let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let store: MemoryStore;

beforeAll(async () => {
  store = new MemoryStore();
  await store.createAdmin({ username: "boss", password_hash: await hashPassword("boss-pass-123"), role: "super" });
  await store.createAdmin({ username: "helper", password_hash: await hashPassword("helper-pass-123"), role: "support" });
  api = createCloudApiServer({ executorUrl: "http://127.0.0.1:9", adminToken: ADMIN_TOKEN, store }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  api.close();
});

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: never }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as never };
}

async function get(path: string, token?: string): Promise<{ status: number; json: never }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, json: (await res.json()) as never };
}

async function registerDevice(fingerprint: string): Promise<{ device_id: string; device_token: string }> {
  const { json } = await post("/v1/devices/register", {
    platform: "windows",
    app_version: "1.0.0",
    device_fingerprint: fingerprint,
  });
  const device = json as { device_id: string; device_token: string };
  return device;
}

describe("Account：注册 / 登录 / 会话", () => {
  it("注册成功返回会话；重复邮箱返回 409", async () => {
    const first = await post("/v1/auth/register", { email: "a@test.cn", password: "password-1" });
    expect(first.status).toBe(201);
    const body = first.json as { user: { user_id: string; email: string }; token: string };
    expect(body.user.email).toBe("a@test.cn");
    expect(body.user).not.toHaveProperty("balance_fen");
    expect(body.token).toMatch(/^us-/);

    const dup = await post("/v1/auth/register", { email: "a@test.cn", password: "password-2" });
    expect(dup.status).toBe(409);
  });

  it("拒绝非法邮箱与弱密码（422）", async () => {
    expect((await post("/v1/auth/register", { email: "bad", password: "password-1" })).status).toBe(422);
    expect((await post("/v1/auth/register", { email: "b@test.cn", password: "short" })).status).toBe(422);
  });

  it("登录成功颁发会话；错误密码 401；会话可访问 /v1/me；登出后失效", async () => {
    const bad = await post("/v1/auth/login", { email: "a@test.cn", password: "wrong-pass" });
    expect(bad.status).toBe(401);

    const ok = await post("/v1/auth/login", { email: "a@test.cn", password: "password-1" });
    expect(ok.status).toBe(200);
    const { token } = ok.json as { token: string };

    const me = await get("/v1/me", token);
    expect(me.status).toBe(200);
    expect((me.json as { email: string }).email).toBe("a@test.cn");

    await post("/v1/auth/logout", {}, token);
    expect((await get("/v1/me", token)).status).toBe(401);
  });
});

describe.skip("历史 Admin Pack 商品：登录 / RBAC / 审计（仅兼容回归）", () => {
  it("管理员登录成功；support 只读、写操作 403", async () => {
    const login = await post("/v1/admin/auth/login", { username: "helper", password: "helper-pass-123" });
    expect(login.status).toBe(200);
    const { token, admin } = login.json as { token: string; admin: { role: string } };
    expect(admin.role).toBe("support");

    expect((await get("/v1/admin/users", token)).status).toBe(200);
    const denied = await post("/v1/admin/products", { pack_id: "p", name: "n", price_monthly_fen: 1, price_yearly_fen: 1 }, token);
    expect(denied.status).toBe(403);
  });

  it("super 管理员会话可写；操作写入审计日志", async () => {
    const login = await post("/v1/admin/auth/login", { username: "boss", password: "boss-pass-123" });
    expect(login.status).toBe(200);
    const { token } = login.json as { token: string };

    const created = await post(
      "/v1/admin/products",
      { pack_id: "longhub.hr-suite", name: "HR 数字员工", description: "简历筛选/Offer/JD", price_monthly_fen: 9900, price_yearly_fen: 69900 },
      token,
    );
    expect(created.status).toBe(201);

    const audits = await get("/v1/admin/audits", token);
    expect(audits.status).toBe(200);
    const actions = (audits.json as { audits: { action: string }[] }).audits.map((a) => a.action);
    expect(actions).toContain("product.create");
    expect(actions).toContain("admin.login");
  });

  it("静态管理凭据仍可用（等价 super）", async () => {
    expect((await get("/v1/admin/metrics", ADMIN_TOKEN)).status).toBe(200);
  });
});

describe.skip("历史 Pack 计费：商品 / 订单 / 钱包 / 授权发放（仅兼容回归）", () => {
  let userToken: string;
  let userId: string;
  let productId: string;
  let deviceId: string;
  let deviceToken: string;

  beforeAll(async () => {
    const reg = await post("/v1/auth/register", { email: "buyer@test.cn", password: "buyer-pass-1" });
    const body = reg.json as { user: { user_id: string }; token: string };
    userToken = body.token;
    userId = body.user.user_id;

    const products = await get("/v1/products");
    productId = (products.json as { products: { product_id: string }[] }).products[0]!.product_id;

    const device = await registerDevice("fp-buyer");
    deviceId = device.device_id;
    deviceToken = device.device_token;
    await post("/v1/me/devices/bind", { device_id: deviceId }, userToken);
  });

  it("公开商品列表仅含上架商品", async () => {
    const res = await get("/v1/products");
    expect(res.status).toBe(200);
    const { products } = res.json as { products: { pack_id: string; price_monthly_fen: number }[] };
    expect(products.length).toBeGreaterThan(0);
    expect(products[0]!.pack_id).toBe("longhub.hr-suite");
  });

  it("充值：创建订单→模拟支付→余额与流水入账", async () => {
    const order = await post("/v1/orders", { type: "recharge", amount_fen: 20000 }, userToken);
    expect(order.status).toBe(201);
    const { order_id } = order.json as { order_id: string };

    const paid = await post(`/v1/orders/${order_id}/pay`, { method: "mock" }, userToken);
    expect(paid.status).toBe(200);
    expect((paid.json as { status: string }).status).toBe("paid");

    const me = await get("/v1/me", userToken);
    expect((me.json as { balance_fen: number }).balance_fen).toBe(20000);

    const txns = await get("/v1/me/transactions", userToken);
    const list = (txns.json as { transactions: { type: string; amount_fen: number }[] }).transactions;
    expect(list[0]!.type).toBe("recharge");
    expect(list[0]!.amount_fen).toBe(20000);
  });

  it("支付方式严格校验，充值订单拒绝余额支付", async () => {
    const created = await post("/v1/orders", { type: "recharge", amount_fen: 777 }, userToken);
    const { order_id } = created.json as { order_id: string };
    const before = ((await get("/v1/me", userToken)).json as { balance_fen: number }).balance_fen;

    const invalid = await post(`/v1/orders/${order_id}/pay`, { method: "wire" }, userToken);
    expect(invalid.status).toBe(422);
    expect(invalid.json).toMatchObject({ code: "INVALID_PAYMENT_METHOD", retryable: false });

    const balance = await post(`/v1/orders/${order_id}/pay`, { method: "balance" }, userToken);
    expect(balance.status).toBe(422);
    expect(balance.json).toMatchObject({ code: "RECHARGE_BALANCE_FORBIDDEN", retryable: false });
    expect(((await get("/v1/me", userToken)).json as { balance_fen: number }).balance_fen).toBe(before);

    const orders = (await get("/v1/me/orders", userToken)).json as {
      orders: Array<{ order_id: string; status: string }>;
    };
    expect(orders.orders.find((order) => order.order_id === order_id)?.status).toBe("pending");
    const transactions = (await get("/v1/me/transactions", userToken)).json as {
      transactions: Array<{ order_id?: string }>;
    };
    expect(transactions.transactions.some((transaction) => transaction.order_id === order_id)).toBe(false);
  });

  it("管理端拒绝把充值订单再次退入钱包", async () => {
    const listed = await get(`/v1/admin/orders?user_id=${userId}`, ADMIN_TOKEN);
    const recharge = (listed.json as {
      orders: Array<{ order_id: string; type: string; status: string }>;
    }).orders.find((order) => order.type === "recharge" && order.status === "paid")!;
    const before = ((await get("/v1/me", userToken)).json as { balance_fen: number }).balance_fen;
    const transactionsBefore = ((await get("/v1/me/transactions", userToken)).json as {
      transactions: unknown[];
    }).transactions.length;

    const refund = await post(`/v1/admin/orders/${recharge.order_id}/refund`, {}, ADMIN_TOKEN);
    expect(refund.status).toBe(409);
    expect(refund.json).toMatchObject({ code: "RECHARGE_REFUND_FORBIDDEN", retryable: false });
    expect(((await get("/v1/me", userToken)).json as { balance_fen: number }).balance_fen).toBe(before);
    expect(((await get("/v1/me/transactions", userToken)).json as {
      transactions: unknown[];
    }).transactions).toHaveLength(transactionsBefore);
    const current = await get(`/v1/admin/orders?user_id=${userId}`, ADMIN_TOKEN);
    expect((current.json as {
      orders: Array<{ order_id: string; status: string }>;
    }).orders.find((order) => order.order_id === recharge.order_id)?.status).toBe("paid");
  });

  it("余额购买订阅：扣款并自动给已绑定设备发授权", async () => {
    const order = await post("/v1/orders", { type: "plan", product_id: productId, period: "monthly" }, userToken);
    expect(order.status).toBe(201);
    const { order_id, amount_fen } = order.json as { order_id: string; amount_fen: number };
    expect(amount_fen).toBe(9900);

    const paid = await post(`/v1/orders/${order_id}/pay`, { method: "balance" }, userToken);
    expect(paid.status).toBe(200);

    const me = await get("/v1/me", userToken);
    expect((me.json as { balance_fen: number }).balance_fen).toBe(20000 - 9900);

    // 设备侧可见授权
    const ents = await get("/v1/entitlements", deviceToken);
    const { entitlements } = ents.json as { entitlements: { pack_id: string; status: string }[] };
    expect(entitlements.some((e) => e.pack_id === "longhub.hr-suite" && e.status === "active")).toBe(true);
  });

  it("余额不足时购买返回 402", async () => {
    const order = await post("/v1/orders", { type: "plan", product_id: productId, period: "yearly" }, userToken);
    const { order_id } = order.json as { order_id: string };
    const paid = await post(`/v1/orders/${order_id}/pay`, { method: "balance" }, userToken);
    expect(paid.status).toBe(402);
  });

  it("新绑定设备自动补发有效订阅授权", async () => {
    const another = await registerDevice("fp-buyer-2");
    const bind = await post("/v1/me/devices/bind", { device_id: another.device_id }, userToken);
    expect(bind.status).toBe(200);

    const ents = await get("/v1/entitlements", another.device_token);
    const { entitlements } = ents.json as { entitlements: { pack_id: string; status: string }[] };
    expect(entitlements.some((e) => e.pack_id === "longhub.hr-suite" && e.status === "active")).toBe(true);
  });

  it("管理端退款：订单转 refunded、金额退回余额并留审计", async () => {
    const orders = await get(`/v1/admin/orders?user_id=${userId}`, ADMIN_TOKEN);
    const paidPlan = (orders.json as { orders: { order_id: string; type: string; status: string; amount_fen: number }[] }).orders.find(
      (o) => o.type === "plan" && o.status === "paid",
    )!;

    const before = ((await get("/v1/me", userToken)).json as { balance_fen: number }).balance_fen;
    const refunded = await post(`/v1/admin/orders/${paidPlan.order_id}/refund`, {}, ADMIN_TOKEN);
    expect(refunded.status).toBe(200);
    expect((refunded.json as { status: string }).status).toBe("refunded");

    const after = ((await get("/v1/me", userToken)).json as { balance_fen: number }).balance_fen;
    expect(after).toBe(before + paidPlan.amount_fen);
  });

  it("管理端调账：入账成功、负值导致余额为负被拒绝", async () => {
    const ok = await post("/v1/admin/wallet/adjust", { user_id: userId, amount_fen: 500, remark: "补偿" }, ADMIN_TOKEN);
    expect(ok.status).toBe(200);

    const bad = await post("/v1/admin/wallet/adjust", { user_id: userId, amount_fen: -99999999 }, ADMIN_TOKEN);
    expect(bad.status).toBe(409);
  });

  it("管理面看板返回汇总数据", async () => {
    const res = await get("/v1/admin/metrics", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const metrics = res.json as { users_total: number; devices_total: number; orders_paid_total: number; revenue_fen: number };
    expect(metrics.users_total).toBeGreaterThanOrEqual(2);
    expect(metrics.devices_total).toBeGreaterThanOrEqual(2);
    expect(metrics.orders_paid_total).toBeGreaterThanOrEqual(1);
  });
});
