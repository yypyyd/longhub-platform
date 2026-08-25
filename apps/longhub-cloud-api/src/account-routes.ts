/**
 * 前台账号与计费路由（官网 Portal 使用）：
 * - 认证：POST /v1/auth/register、/v1/auth/login、/v1/auth/logout
 * - 我的：GET /v1/me、/v1/me/orders、/v1/me/devices、Cloud Skill plans/subscriptions/entitlements
 * - 订单：POST /v1/orders（仅 cloud_skill_plan；provider 支付接入前保持未结算）
 * - 设备：使用 Manager 一次性 pairing code 绑定；UUID-only bind 与旧 Pack/钱包入口固定返回 410/503
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { StructuredLogger } from "@longhub/observability";
import { hashPassword, newToken, sessionExpiry, verifyPassword } from "./auth.js";
import { bearerToken, readJson, sendError, sendJson } from "./http-util.js";
import { BillingSettlementError } from "./store.js";
import type {
  CloudSkillPlanRecord,
  CloudSkillSubscriptionRecord,
  CloudStore,
  OrderRecord,
  UserRecord,
} from "./store.js";

export interface AccountRouteContext {
  store: CloudStore;
  logger: StructuredLogger;
  /** Legacy Pack/HR/wallet/product surfaces remain explicit 410 compatibility routes. */
  legacySurfaceEnabled?: boolean;
  /** Mock settlement is a test-only compatibility helper, never production. */
  allowMockPayment?: boolean;
}

function legacySurfaceEnabled(ctx: AccountRouteContext): boolean {
  // Compatibility must be an explicit opt-in.  Treat an omitted flag as the
  // clean-launch product so direct handler callers cannot accidentally expose
  // wallet/Pack fields that the server bootstrap normally hides.
  return ctx.legacySurfaceEnabled === true;
}

function sendLegacySurfaceDisabled(res: ServerResponse): void {
  sendError(res, 410, "LEGACY_SURFACE_DISABLED", "该旧产品入口已下线");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{12}$/;

function normalizePairingCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  return PAIRING_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

function hashPairingCode(code: string): string {
  return `v1:${createHash("sha256").update(code, "utf8").digest("hex")}`;
}

function publicUser(user: UserRecord, includeLegacyBilling = false): Record<string, unknown> {
  return {
    user_id: user.user_id,
    email: user.email,
    status: user.status,
    ...(includeLegacyBilling ? { balance_fen: user.balance_fen } : {}),
    created_at: user.created_at,
  };
}

/** 订阅有效期（天）：月付 31 天、年付 366 天 */
function periodDays(period: "monthly" | "yearly"): number {
  return period === "monthly" ? 31 : 366;
}

function planExpiry(paidAt: string, period: "monthly" | "yearly"): string {
  return new Date(new Date(paidAt).getTime() + periodDays(period) * 24 * 60 * 60 * 1000).toISOString();
}

function settlementIdempotencyKey(req: IncomingMessage, operation: "pay" | "refund", orderId: string): string {
  const header = req.headers["idempotency-key"];
  if (header === undefined) return `${operation}:${orderId}`;
  if (Array.isArray(header)) throw new BillingSettlementError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be a single value");
  if (!/^[\x21-\x7e]{1,128}$/.test(header)) {
    throw new BillingSettlementError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key format is invalid");
  }
  return header;
}

function settlementRequestHash(value: unknown): string {
  return `v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sendSettlementError(res: ServerResponse, error: unknown): void {
  if (error instanceof BillingSettlementError) {
    const messages: Partial<Record<string, string>> = {
      ORDER_NOT_FOUND: "订单不存在",
      ORDER_NOT_PENDING: "订单已处理，无法重复支付",
      ORDER_NOT_PAID: "订单尚未支付，无法退款",
      INVALID_PAYMENT_METHOD: "method 必须为 balance 或 mock",
      RECHARGE_BALANCE_FORBIDDEN: "充值订单不能使用钱包余额支付",
      RECHARGE_REFUND_FORBIDDEN: "充值订单不能退款入钱包",
      INSUFFICIENT_BALANCE: "余额不足，请先充值",
      IDEMPOTENCY_KEY_INVALID: "Idempotency-Key 格式无效",
      IDEMPOTENCY_CONFLICT: "幂等键已用于不同请求",
      REFUND_REQUIRES_RECONCILIATION: "订单授权来源无法自动核对，请人工对账",
      FULFILLMENT_INVALID: "订单履约数据无效",
      SETTLEMENT_UNAVAILABLE: "结算服务暂时不可用，请稍后重试",
    };
    sendError(res, error.status, error.code, messages[error.code] ?? error.message,
      error.code === "SETTLEMENT_UNAVAILABLE");
    return;
  }
  sendError(res, 503, "SETTLEMENT_UNAVAILABLE", "结算服务暂时不可用，请稍后重试", true);
}

function isCloudSkillPlanOrder(order: OrderRecord): order is OrderRecord & {
  type: "cloud_skill_plan";
  plan_id: string;
  period: "monthly" | "yearly";
  paid_at: string;
} {
  return order.type === "cloud_skill_plan" && typeof order.plan_id === "string" &&
    (order.period === "monthly" || order.period === "yearly") && typeof order.paid_at === "string";
}

async function cloudPlanForOrder(ctx: AccountRouteContext, order: OrderRecord): Promise<CloudSkillPlanRecord | undefined> {
  return order.plan_id ? ctx.store.getCloudSkillPlan(order.plan_id) : undefined;
}

export async function authenticateUser(
  ctx: AccountRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<UserRecord | undefined> {
  const token = bearerToken(req);
  const session = token ? await ctx.store.getSession(token) : undefined;
  const user = session?.subject_type === "user" ? await ctx.store.getUser(session.subject_id) : undefined;
  if (!user || user.status !== "active") {
    sendError(res, 401, "UNAUTHORIZED", "缺少或无效的用户会话");
    return undefined;
  }
  return user;
}

/** 把用户所有未过期的已支付订阅授权补发到指定设备（绑定新设备时调用） */
async function syncEntitlementsToDevice(ctx: AccountRouteContext, userId: string, deviceId: string): Promise<void> {
  const device = await ctx.store.getDevice(deviceId);
  if (!device) return;
  const now = new Date().toISOString();
  const existing = await ctx.store.listEntitlements(deviceId);
  if (legacySurfaceEnabled(ctx)) {
    for (const order of await ctx.store.listOrders(userId)) {
      if (order.type !== "plan" || order.status !== "paid" || !order.pack_id || !order.period || !order.paid_at) continue;
      const expiresAt = planExpiry(order.paid_at, order.period);
      if (expiresAt <= now) continue;
      const dup = existing.some((e) => e.source_order_id === order.order_id && e.pack_id === order.pack_id &&
        e.status === "active" && e.expires_at > now);
      if (dup) continue;
      await ctx.store.grantEntitlement({
        tenant_id: device.tenant_id,
        device_id: deviceId,
        pack_id: order.pack_id,
        scope: "user",
        expires_at: expiresAt,
        source_order_id: order.order_id,
      });
    }
  }

  // Cloud Skill entitlement is user + tenant scoped, not copied into legacy
  // device/pack rows. Binding a device only repairs missing rows for an already
  // valid subscription in that same tenant.
  const cloudEntitlements = await ctx.store.listCloudSkillEntitlements({
    user_id: userId,
    tenant_id: device.tenant_id,
  });
  for (const subscription of await ctx.store.listCloudSkillSubscriptions(userId)) {
    if (subscription.tenant_id !== device.tenant_id || subscription.status !== "active" ||
      subscription.starts_at > now || subscription.expires_at <= now) continue;
    const plan = await ctx.store.getCloudSkillPlan(subscription.plan_id);
    if (!plan) continue;
    for (const skillId of plan.skill_ids) {
      const exists = cloudEntitlements.some((entitlement) =>
        entitlement.subscription_id === subscription.subscription_id && entitlement.plan_id === plan.plan_id &&
        entitlement.skill_id === skillId && entitlement.status === "active" && entitlement.expires_at > now,
      );
      if (!exists) {
        await ctx.store.grantCloudSkillEntitlement({
          subscription_id: subscription.subscription_id,
          skill_id: skillId,
          plan_id: plan.plan_id,
          expires_at: subscription.expires_at,
        });
      }
    }
  }
}

/** 订单支付成功后：订阅类订单给用户所有已绑定设备发授权 */
async function fulfillPlanOrder(ctx: AccountRouteContext, order: OrderRecord): Promise<void> {
  if (order.type !== "plan" || !order.pack_id || !order.period || !order.paid_at) return;
  const expiresAt = planExpiry(order.paid_at, order.period);
  for (const device of await ctx.store.listDevices(order.user_id)) {
    if (device.status !== "active") continue;
    await ctx.store.grantEntitlement({
      tenant_id: device.tenant_id,
      device_id: device.device_id,
      pack_id: order.pack_id,
      scope: "user",
      expires_at: expiresAt,
      source_order_id: order.order_id,
    });
  }
}

/** Paid Cloud Skill order fulfillment is idempotent by source_order_id and by
 * (subscription_id, skill_id, plan_id). It never creates Pack entitlements. */
async function fulfillCloudSkillOrder(
  ctx: AccountRouteContext,
  order: OrderRecord,
): Promise<{ subscription: CloudSkillSubscriptionRecord; entitlements: number } | undefined> {
  if (!isCloudSkillPlanOrder(order) || !order.tenant_id) return undefined;
  const plan = await cloudPlanForOrder(ctx, order);
  if (!plan) throw new Error("CLOUD_SKILL_PLAN_NOT_FOUND");
  const startsAt = order.paid_at;
  const expiresAt = planExpiry(startsAt, order.period);
  const { subscription } = await ctx.store.createCloudSkillSubscription({
    user_id: order.user_id,
    tenant_id: order.tenant_id,
    plan_id: plan.plan_id,
    period: order.period,
    starts_at: startsAt,
    expires_at: expiresAt,
    source_order_id: order.order_id,
  });
  for (const skillId of plan.skill_ids) {
    await ctx.store.grantCloudSkillEntitlement({
      subscription_id: subscription.subscription_id,
      skill_id: skillId,
      plan_id: plan.plan_id,
      expires_at: subscription.expires_at,
    });
  }
  return { subscription, entitlements: plan.skill_ids.length };
}

/** 返回 true 表示本模块已处理该请求 */
export async function handleAccountRoutes(
  ctx: AccountRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
): Promise<boolean> {
  // POST /v1/auth/register
  if (req.method === "POST" && url.pathname === "/v1/auth/register") {
    const parsed = await readJson<{ email?: string; password?: string }>(req, res);
    if (!parsed) return true;
    if (typeof parsed.email !== "string" ||
      parsed.email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(parsed.email)) {
      sendError(res, 422, "INVALID_EMAIL", "邮箱格式不正确");
      return true;
    }
    if (typeof parsed.password !== "string" || parsed.password.length < 8 || parsed.password.length > 256) {
      sendError(res, 422, "INVALID_PASSWORD", "密码长度必须为 8-256 位");
      return true;
    }
    const { user, existed } = await ctx.store.createUser({
      email: parsed.email.toLowerCase(),
      password_hash: await hashPassword(parsed.password),
    });
    if (existed) {
      sendError(res, 409, "EMAIL_EXISTS", "邮箱已注册");
      return true;
    }
    const token = newToken("us");
    await ctx.store.createSession({ subject_type: "user", subject_id: user.user_id, token, expires_at: sessionExpiry() });
    ctx.logger.info("user.registered", { user_id: user.user_id });
    sendJson(res, 201, { user: publicUser(user, legacySurfaceEnabled(ctx)), token });
    return true;
  }

  // POST /v1/auth/login
  if (req.method === "POST" && url.pathname === "/v1/auth/login") {
    const parsed = await readJson<{ email?: string; password?: string }>(req, res);
    if (!parsed) return true;
    const validEmail = typeof parsed.email === "string" && parsed.email.length <= MAX_EMAIL_LENGTH;
    const user = validEmail ? await ctx.store.getUserByEmail(parsed.email!.toLowerCase()) : undefined;
    if (!user || typeof parsed.password !== "string" || parsed.password.length > 256 ||
      !(await verifyPassword(parsed.password, user.password_hash))) {
      sendError(res, 401, "BAD_CREDENTIALS", "邮箱或密码错误");
      return true;
    }
    if (user.status !== "active") {
      sendError(res, 403, "USER_DISABLED", "账号已被停用");
      return true;
    }
    const token = newToken("us");
    await ctx.store.createSession({ subject_type: "user", subject_id: user.user_id, token, expires_at: sessionExpiry() });
    sendJson(res, 200, { user: publicUser(user, legacySurfaceEnabled(ctx)), token });
    return true;
  }

  // POST /v1/auth/logout
  if (req.method === "POST" && url.pathname === "/v1/auth/logout") {
    const token = bearerToken(req);
    if (token) await ctx.store.deleteSession(token);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // GET /v1/products（公开，仅上架商品）
  if (req.method === "GET" && url.pathname === "/v1/products") {
    if (!legacySurfaceEnabled(ctx)) {
      sendLegacySurfaceDisabled(res);
      return true;
    }
    const products = (await ctx.store.listProducts()).filter((p) => p.status === "listed");
    sendJson(res, 200, { products });
    return true;
  }

  // GET /v1/cloud-skill-plans（公开，仅返回上架计划的公开额度/价格元数据）
  if (req.method === "GET" && url.pathname === "/v1/cloud-skill-plans") {
    const plans = await ctx.store.listCloudSkillPlans("listed");
    sendJson(res, 200, { plans });
    return true;
  }

  // GET /v1/me
  if (req.method === "GET" && url.pathname === "/v1/me") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    sendJson(res, 200, publicUser(user, legacySurfaceEnabled(ctx)));
    return true;
  }

  // GET /v1/me/orders | /v1/me/transactions | /v1/me/devices | /v1/me/entitlements
  if (req.method === "GET" && parts[0] === "v1" && parts[1] === "me" && parts.length === 3) {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    if (parts[2] === "orders") {
      const orders = await ctx.store.listOrders(user.user_id);
      sendJson(res, 200, {
        orders: legacySurfaceEnabled(ctx) ? orders : orders.filter((order) => order.type === "cloud_skill_plan"),
      });
      return true;
    }
    if (parts[2] === "transactions") {
      if (!legacySurfaceEnabled(ctx)) {
        sendLegacySurfaceDisabled(res);
        return true;
      }
      sendJson(res, 200, { transactions: await ctx.store.listTransactions(user.user_id) });
      return true;
    }
    if (parts[2] === "devices") {
      const devices = (await ctx.store.listDevices(user.user_id)).map((d) => ({
        device_id: d.device_id,
        status: d.status,
        platform: d.platform,
        app_version: d.app_version,
        display_name: d.display_name,
        created_at: d.created_at,
      }));
      sendJson(res, 200, { devices });
      return true;
    }
    if (parts[2] === "entitlements") {
      if (!legacySurfaceEnabled(ctx)) {
        sendLegacySurfaceDisabled(res);
        return true;
      }
      const devices = await ctx.store.listDevices(user.user_id);
      const entitlements = [];
      for (const device of devices) entitlements.push(...(await ctx.store.listEntitlements(device.device_id)));
      sendJson(res, 200, { entitlements });
      return true;
    }
    if (parts[2] === "cloud-skill-subscriptions") {
      sendJson(res, 200, { subscriptions: await ctx.store.listCloudSkillSubscriptions(user.user_id) });
      return true;
    }
    if (parts[2] === "cloud-skill-entitlements") {
      sendJson(res, 200, {
        entitlements: await ctx.store.listCloudSkillEntitlements({ user_id: user.user_id }),
      });
      return true;
    }
  }

  // POST /v1/me/cloud-skill-subscriptions/{id}/cancel
  if (req.method === "POST" && parts.length === 5 && parts[0] === "v1" && parts[1] === "me" &&
    parts[2] === "cloud-skill-subscriptions" && parts[4] === "cancel") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    const subscription = await ctx.store.getCloudSkillSubscription(parts[3]!);
    if (!subscription || subscription.user_id !== user.user_id) {
      sendError(res, 404, "CLOUD_SKILL_SUBSCRIPTION_NOT_FOUND", "订阅不存在");
      return true;
    }
    if (subscription.status !== "active") {
      sendError(res, 409, "CLOUD_SKILL_SUBSCRIPTION_NOT_ACTIVE", `订阅状态为 ${subscription.status}`);
      return true;
    }
    const cancelled = await ctx.store.updateCloudSkillSubscriptionStatus(subscription.subscription_id, "cancelled");
    ctx.logger.info("cloud_skill.subscription.cancelled", {
      subscription_id: subscription.subscription_id,
      plan_id: subscription.plan_id,
    });
    sendJson(res, 200, cancelled);
    return true;
  }

  // POST /v1/me/devices/pair - redeem a one-time proof minted by longhub-cloud.
  if (req.method === "POST" && url.pathname === "/v1/me/devices/pair") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    const parsed = await readJson<{ pairing_code?: unknown }>(req, res);
    if (!parsed) return true;
    // The clean-launch pairing contract has exactly one client-controlled
    // field.  Rejecting unknown fields prevents callers from smuggling the
    // retired device-id/token binding surface back into this endpoint and
    // keeps the request semantics stable for the Portal.
    if (typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => key !== "pairing_code")) {
      sendError(res, 422, "INVALID_PAIRING_REQUEST", "配对请求字段无效");
      return true;
    }
    const pairingCode = normalizePairingCode(parsed.pairing_code);
    if (!pairingCode) {
      sendError(res, 422, "PAIRING_CODE_INVALID", "一次性配对码无效或格式不正确");
      return true;
    }
    let result;
    try {
      result = await ctx.store.consumeDevicePairingChallenge({
        code_hash: hashPairingCode(pairingCode),
        user_id: user.user_id,
        now: new Date().toISOString(),
      });
    } catch {
      sendError(res, 503, "PAIRING_UNAVAILABLE", "设备配对服务暂时不可用", true);
      return true;
    }
    if (!result.ok) {
      const errors: Record<typeof result.reason, { status: number; code: string; message: string; retryable?: boolean }> = {
        CODE_INVALID: { status: 422, code: "PAIRING_CODE_INVALID", message: "一次性配对码无效或已使用" },
        CODE_EXPIRED: { status: 410, code: "PAIRING_CODE_EXPIRED", message: "一次性配对码已过期，请回到管家重新生成" },
        DEVICE_NOT_FOUND: { status: 422, code: "PAIRING_CODE_INVALID", message: "一次性配对码无效或已使用" },
        DEVICE_ALREADY_BOUND: { status: 409, code: "DEVICE_ALREADY_BOUND", message: "设备已经绑定账号" },
        DEVICE_REVOKED: { status: 403, code: "DEVICE_REVOKED", message: "设备凭据已撤销" },
      };
      const problem = errors[result.reason];
      sendError(res, problem.status, problem.code, problem.message, problem.retryable);
      return true;
    }
    const device = result.device;
    await ctx.store.appendAudit(`user:${user.user_id}`, "device.paired", {
      device_id: device.device_id,
      tenant_id: device.tenant_id,
    });
    sendJson(res, 200, {
      device: {
        device_id: device.device_id,
        status: device.status,
        platform: device.platform,
        app_version: device.app_version,
        display_name: device.display_name,
        created_at: device.created_at,
      },
    });
    return true;
  }

  // UUID-only binding is intentionally retired in the clean-launch product.
  if (req.method === "POST" && url.pathname === "/v1/me/devices/bind") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    void user;
    sendError(res, 410, "PAIRING_CODE_REQUIRED", "请使用 LongHub 管家生成的一次性配对码");
    return true;
  }

  // POST /v1/orders
  if (req.method === "POST" && url.pathname === "/v1/orders") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    const parsed = await readJson<{
      type?: "plan" | "cloud_skill_plan" | "recharge";
      product_id?: string;
      plan_id?: string;
      tenant_id?: string;
      period?: "monthly" | "yearly";
      amount_fen?: number;
    }>(req, res);
    if (!parsed) return true;
    if (!legacySurfaceEnabled(ctx) && (parsed.type === "plan" || parsed.type === "recharge")) {
      sendLegacySurfaceDisabled(res);
      return true;
    }
    if (parsed.type === "recharge") {
      if (typeof parsed.amount_fen !== "number" || !Number.isInteger(parsed.amount_fen) || parsed.amount_fen <= 0) {
        sendError(res, 422, "INVALID_AMOUNT", "amount_fen 必须为正整数（单位分）");
        return true;
      }
      const order = await ctx.store.createOrder({ user_id: user.user_id, type: "recharge", amount_fen: parsed.amount_fen });
      sendJson(res, 201, order);
      return true;
    }
    if (parsed.type === "plan") {
      const product = typeof parsed.product_id === "string" ? await ctx.store.getProduct(parsed.product_id) : undefined;
      if (!product || product.status !== "listed") {
        sendError(res, 404, "PRODUCT_NOT_FOUND", "商品不存在或未上架");
        return true;
      }
      if (parsed.period !== "monthly" && parsed.period !== "yearly") {
        sendError(res, 422, "INVALID_PERIOD", "period 必须为 monthly 或 yearly");
        return true;
      }
      const amount = parsed.period === "monthly" ? product.price_monthly_fen : product.price_yearly_fen;
      const order = await ctx.store.createOrder({
        user_id: user.user_id,
        type: "plan",
        product_id: product.product_id,
        pack_id: product.pack_id,
        period: parsed.period,
        amount_fen: amount,
      });
      sendJson(res, 201, order);
      return true;
    }
    if (parsed.type === "cloud_skill_plan") {
      const plan = typeof parsed.plan_id === "string" ? await ctx.store.getCloudSkillPlan(parsed.plan_id) : undefined;
      if (!plan || plan.status !== "listed") {
        sendError(res, 404, "CLOUD_SKILL_PLAN_NOT_FOUND", "云端 Skill 计划不存在或未上架");
        return true;
      }
      if (parsed.period !== "monthly" && parsed.period !== "yearly") {
        sendError(res, 422, "INVALID_PERIOD", "period 必须为 monthly 或 yearly");
        return true;
      }
      const devices = (await ctx.store.listDevices(user.user_id)).filter((device) => device.status === "active");
      const tenantId = parsed.tenant_id ?? devices[0]?.tenant_id;
      if (!tenantId) {
        sendError(res, 409, "CLOUD_SKILL_DEVICE_REQUIRED", "购买云端 Skill 前请先绑定设备");
        return true;
      }
      if (!devices.some((device) => device.tenant_id === tenantId)) {
        sendError(res, 403, "CLOUD_SKILL_TENANT_FORBIDDEN", "设备不属于该租户");
        return true;
      }
      const amount = parsed.period === "monthly" ? plan.price_monthly_fen : plan.price_yearly_fen;
      const order = await ctx.store.createOrder({
        user_id: user.user_id,
        type: "cloud_skill_plan",
        plan_id: plan.plan_id,
        tenant_id: tenantId,
        period: parsed.period,
        amount_fen: amount,
      });
      sendJson(res, 201, order);
      return true;
    }
    sendError(res, 422, "INVALID_ORDER", legacySurfaceEnabled(ctx)
      ? "type 必须为 plan、cloud_skill_plan 或 recharge"
      : "type 必须为 cloud_skill_plan");
    return true;
  }

  // POST /v1/orders/{orderId}/pay（余额支付或模拟支付；正式支付渠道接入后替换 mock）
  if (req.method === "POST" && parts[0] === "v1" && parts[1] === "orders" && parts.length === 4 && parts[3] === "pay") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    const order = await ctx.store.getOrder(parts[2]!);
    if (!order || order.user_id !== user.user_id) {
      sendError(res, 404, "ORDER_NOT_FOUND", `未知订单: ${parts[2]}`);
      return true;
    }
    if (!legacySurfaceEnabled(ctx) && order.type !== "cloud_skill_plan") {
      sendLegacySurfaceDisabled(res);
      return true;
    }
    const parsed = await readJson<{ method?: "balance" | "mock" }>(req, res);
    if (!parsed) return true;
    const method = parsed.method === undefined ? "mock" : parsed.method;
    if (method === "mock" && !ctx.allowMockPayment) {
      sendError(res, 503, "PAYMENT_NOT_CONFIGURED", "正式支付渠道尚未配置，模拟支付仅用于开发/测试", true);
      return true;
    }
    if (method === "balance" && !legacySurfaceEnabled(ctx)) {
      sendLegacySurfaceDisabled(res);
      return true;
    }
    try {
      const key = settlementIdempotencyKey(req, "pay", order.order_id);
      const requestHash = settlementRequestHash({
        operation: "payment",
        order_id: order.order_id,
        user_id: user.user_id,
        method,
      });
      const settled = await ctx.store.settleOrderPayment({
        order_id: order.order_id,
        user_id: user.user_id,
        method: method as "balance" | "mock",
        idempotency_key: key,
        request_hash: requestHash,
      });
      ctx.logger.info("order.paid", {
        order_id: order.order_id,
        type: order.type,
        replayed: settled.replayed,
        ...(order.pack_id ? { pack_id: order.pack_id } : {}),
        ...(order.plan_id ? { plan_id: order.plan_id } : {}),
      });
      // Keep the historical flat order response while exposing settlement
      // metadata for clients that need to distinguish a replay.
      sendJson(res, 200, { ...settled.order, replayed: settled.replayed, settlement_id: settled.settlement.settlement_id });
    } catch (error) {
      sendSettlementError(res, error);
    }
    return true;
  }

  return false;
}
