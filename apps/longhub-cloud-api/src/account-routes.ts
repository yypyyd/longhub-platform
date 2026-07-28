/**
 * 前台账号与计费路由（官网 Portal 使用）：
 * - 认证：POST /v1/auth/register、/v1/auth/login、/v1/auth/logout
 * - 我的：GET /v1/me、/v1/me/orders、/v1/me/transactions、/v1/me/devices、/v1/me/entitlements
 * - 商品：GET /v1/products（公开，仅上架）
 * - 订单：POST /v1/orders（plan/recharge）、POST /v1/orders/{id}/pay（余额或模拟支付）
 * - 设备：POST /v1/me/devices/bind（绑定后自动补发有效订阅授权）
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@longhub/observability";
import { hashPassword, newToken, sessionExpiry, verifyPassword } from "./auth.js";
import { bearerToken, readJson, sendError, sendJson } from "./http-util.js";
import type { CloudStore, OrderRecord, UserRecord } from "./store.js";

export interface AccountRouteContext {
  store: CloudStore;
  logger: StructuredLogger;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user: UserRecord): Record<string, unknown> {
  return {
    user_id: user.user_id,
    email: user.email,
    status: user.status,
    balance_fen: user.balance_fen,
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
  for (const order of await ctx.store.listOrders(userId)) {
    if (order.type !== "plan" || order.status !== "paid" || !order.pack_id || !order.period || !order.paid_at) continue;
    const expiresAt = planExpiry(order.paid_at, order.period);
    if (expiresAt <= now) continue;
    const dup = existing.some((e) => e.pack_id === order.pack_id && e.status === "active" && e.expires_at > now);
    if (dup) continue;
    await ctx.store.grantEntitlement({
      tenant_id: device.tenant_id,
      device_id: deviceId,
      pack_id: order.pack_id,
      scope: "user",
      expires_at: expiresAt,
    });
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
    });
  }
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
    if (typeof parsed.email !== "string" || !EMAIL_RE.test(parsed.email)) {
      sendError(res, 422, "INVALID_EMAIL", "邮箱格式不正确");
      return true;
    }
    if (typeof parsed.password !== "string" || parsed.password.length < 8) {
      sendError(res, 422, "INVALID_PASSWORD", "密码至少 8 位");
      return true;
    }
    const { user, existed } = await ctx.store.createUser({
      email: parsed.email.toLowerCase(),
      password_hash: hashPassword(parsed.password),
    });
    if (existed) {
      sendError(res, 409, "EMAIL_EXISTS", "邮箱已注册");
      return true;
    }
    const token = newToken("us");
    await ctx.store.createSession({ subject_type: "user", subject_id: user.user_id, token, expires_at: sessionExpiry() });
    ctx.logger.info("user.registered", { user_id: user.user_id });
    sendJson(res, 201, { user: publicUser(user), token });
    return true;
  }

  // POST /v1/auth/login
  if (req.method === "POST" && url.pathname === "/v1/auth/login") {
    const parsed = await readJson<{ email?: string; password?: string }>(req, res);
    if (!parsed) return true;
    const user = typeof parsed.email === "string" ? await ctx.store.getUserByEmail(parsed.email.toLowerCase()) : undefined;
    if (!user || typeof parsed.password !== "string" || !verifyPassword(parsed.password, user.password_hash)) {
      sendError(res, 401, "BAD_CREDENTIALS", "邮箱或密码错误");
      return true;
    }
    if (user.status !== "active") {
      sendError(res, 403, "USER_DISABLED", "账号已被停用");
      return true;
    }
    const token = newToken("us");
    await ctx.store.createSession({ subject_type: "user", subject_id: user.user_id, token, expires_at: sessionExpiry() });
    sendJson(res, 200, { user: publicUser(user), token });
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
    const products = (await ctx.store.listProducts()).filter((p) => p.status === "listed");
    sendJson(res, 200, { products });
    return true;
  }

  // GET /v1/me
  if (req.method === "GET" && url.pathname === "/v1/me") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    sendJson(res, 200, publicUser(user));
    return true;
  }

  // GET /v1/me/orders | /v1/me/transactions | /v1/me/devices | /v1/me/entitlements
  if (req.method === "GET" && parts[0] === "v1" && parts[1] === "me" && parts.length === 3) {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    if (parts[2] === "orders") {
      sendJson(res, 200, { orders: await ctx.store.listOrders(user.user_id) });
      return true;
    }
    if (parts[2] === "transactions") {
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
      const devices = await ctx.store.listDevices(user.user_id);
      const entitlements = [];
      for (const device of devices) entitlements.push(...(await ctx.store.listEntitlements(device.device_id)));
      sendJson(res, 200, { entitlements });
      return true;
    }
  }

  // POST /v1/me/devices/bind
  if (req.method === "POST" && url.pathname === "/v1/me/devices/bind") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    const parsed = await readJson<{ device_id?: string }>(req, res);
    if (!parsed) return true;
    if (typeof parsed.device_id !== "string") {
      sendError(res, 422, "INVALID_BIND", "device_id 必填");
      return true;
    }
    const device = await ctx.store.getDevice(parsed.device_id);
    if (!device) {
      sendError(res, 404, "DEVICE_NOT_FOUND", `未知设备: ${parsed.device_id}`);
      return true;
    }
    if (device.user_id && device.user_id !== user.user_id) {
      sendError(res, 409, "DEVICE_BOUND", "设备已绑定其他账号");
      return true;
    }
    const bound = await ctx.store.bindDevice(device.device_id, user.user_id);
    await syncEntitlementsToDevice(ctx, user.user_id, device.device_id);
    ctx.logger.info("device.bound", { device_id: device.device_id, user_id: user.user_id });
    sendJson(res, 200, { device_id: bound!.device_id, user_id: bound!.user_id });
    return true;
  }

  // POST /v1/orders
  if (req.method === "POST" && url.pathname === "/v1/orders") {
    const user = await authenticateUser(ctx, req, res);
    if (!user) return true;
    const parsed = await readJson<{
      type?: "plan" | "recharge";
      product_id?: string;
      period?: "monthly" | "yearly";
      amount_fen?: number;
    }>(req, res);
    if (!parsed) return true;
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
    sendError(res, 422, "INVALID_ORDER", "type 必须为 plan 或 recharge");
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
    if (order.status !== "pending") {
      sendError(res, 409, "ORDER_NOT_PENDING", `订单状态为 ${order.status}，无法支付`);
      return true;
    }
    const parsed = await readJson<{ method?: "balance" | "mock" }>(req, res);
    if (!parsed) return true;
    const method = parsed.method ?? "mock";
    if (order.type === "recharge") {
      // 充值订单只能走外部（模拟）支付
      await ctx.store.addWalletTransaction({
        user_id: user.user_id,
        type: "recharge",
        amount_fen: order.amount_fen,
        order_id: order.order_id,
        remark: "模拟支付充值",
      });
      const paid = await ctx.store.updateOrder(order.order_id, {
        status: "paid",
        pay_method: "mock",
        paid_at: new Date().toISOString(),
      });
      ctx.logger.info("order.paid", { order_id: order.order_id, type: "recharge" });
      sendJson(res, 200, paid);
      return true;
    }
    // plan 订单：balance 走钱包扣款，mock 模拟外部支付
    if (method === "balance") {
      try {
        await ctx.store.addWalletTransaction({
          user_id: user.user_id,
          type: "purchase",
          amount_fen: -order.amount_fen,
          order_id: order.order_id,
          remark: "余额购买订阅",
        });
      } catch (err) {
        if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
          sendError(res, 402, "INSUFFICIENT_BALANCE", "余额不足，请先充值");
          return true;
        }
        throw err;
      }
    }
    const paid = await ctx.store.updateOrder(order.order_id, {
      status: "paid",
      pay_method: method,
      paid_at: new Date().toISOString(),
    });
    await fulfillPlanOrder(ctx, paid!);
    ctx.logger.info("order.paid", { order_id: order.order_id, type: "plan", pack_id: order.pack_id });
    sendJson(res, 200, paid);
    return true;
  }

  return false;
}
