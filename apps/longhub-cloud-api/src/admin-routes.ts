/**
 * 后台管理路由（Admin Web 使用）：
 * - 认证：POST /v1/admin/auth/login（管理员账号）；静态 ADMIN_TOKEN 仍可用（等价 super）
 * - RBAC：super/ops 可写，support 只读；所有写操作记审计日志
 * - 用户：GET /v1/admin/users、POST /v1/admin/users/{id}/status
 * - 设备/授权：GET /v1/admin/devices、GET /v1/admin/entitlements
 * - 商品：GET/POST /v1/admin/products、POST /v1/admin/products/{id}
 * - 订单/钱包：GET /v1/admin/orders、POST /v1/admin/orders/{id}/refund、
 *   POST /v1/admin/wallet/adjust、GET /v1/admin/transactions
 * - 套装：GET /v1/admin/packs（发布/吊销在 server.ts 既有路由）
 * - 审计与看板：GET /v1/admin/audits、GET /v1/admin/metrics
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StructuredLogger } from "@longhub/observability";
import { newToken, sessionExpiry, verifyPassword } from "./auth.js";
import { bearerToken, readJson, sendError, sendJson } from "./http-util.js";
import type { AdminRole, CloudStore } from "./store.js";

export interface AdminRouteContext {
  store: CloudStore;
  adminToken: string;
  logger: StructuredLogger;
}

export interface AdminIdentity {
  actor: string;
  role: AdminRole;
}

/** 校验管理身份：静态管理凭据（super）或管理员会话；write 为 true 时 support 拒绝 */
export async function requireAdmin(
  ctx: AdminRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  opts: { write: boolean },
): Promise<AdminIdentity | undefined> {
  const token = bearerToken(req);
  if (!token) {
    sendError(res, 401, "UNAUTHORIZED", "缺少或无效的管理凭据");
    return undefined;
  }
  if (token === ctx.adminToken) return { actor: "static-admin-token", role: "super" };
  const session = await ctx.store.getSession(token);
  const admin = session?.subject_type === "admin" ? await ctx.store.getAdmin(session.subject_id) : undefined;
  if (!admin || admin.status !== "active") {
    sendError(res, 401, "UNAUTHORIZED", "缺少或无效的管理凭据");
    return undefined;
  }
  if (opts.write && admin.role === "support") {
    sendError(res, 403, "FORBIDDEN", "support 角色仅可查看");
    return undefined;
  }
  return { actor: `${admin.username}(${admin.admin_id})`, role: admin.role };
}

/** 返回 true 表示本模块已处理该请求 */
export async function handleAdminRoutes(
  ctx: AdminRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
): Promise<boolean> {
  if (parts[0] !== "v1" || parts[1] !== "admin") return false;

  // POST /v1/admin/auth/login（无需先有凭据）
  if (req.method === "POST" && url.pathname === "/v1/admin/auth/login") {
    const parsed = await readJson<{ username?: string; password?: string }>(req, res);
    if (!parsed) return true;
    const admin = typeof parsed.username === "string" ? await ctx.store.getAdminByUsername(parsed.username) : undefined;
    if (!admin || typeof parsed.password !== "string" || !verifyPassword(parsed.password, admin.password_hash)) {
      sendError(res, 401, "BAD_CREDENTIALS", "用户名或密码错误");
      return true;
    }
    if (admin.status !== "active") {
      sendError(res, 403, "ADMIN_DISABLED", "管理员账号已停用");
      return true;
    }
    const token = newToken("as");
    await ctx.store.createSession({ subject_type: "admin", subject_id: admin.admin_id, token, expires_at: sessionExpiry() });
    await ctx.store.appendAudit(`${admin.username}(${admin.admin_id})`, "admin.login");
    sendJson(res, 200, { token, admin: { admin_id: admin.admin_id, username: admin.username, role: admin.role } });
    return true;
  }

  // GET /v1/admin/users
  if (req.method === "GET" && url.pathname === "/v1/admin/users") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    const users = (await ctx.store.listUsers()).map((u) => ({
      user_id: u.user_id,
      email: u.email,
      status: u.status,
      balance_fen: u.balance_fen,
      created_at: u.created_at,
    }));
    sendJson(res, 200, { users });
    return true;
  }

  // POST /v1/admin/users/{id}/status
  if (req.method === "POST" && parts.length === 5 && parts[2] === "users" && parts[4] === "status") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<{ status?: "active" | "disabled" }>(req, res);
    if (!parsed) return true;
    if (parsed.status !== "active" && parsed.status !== "disabled") {
      sendError(res, 422, "INVALID_STATUS", "status 必须为 active 或 disabled");
      return true;
    }
    const user = await ctx.store.setUserStatus(parts[3]!, parsed.status);
    if (!user) {
      sendError(res, 404, "USER_NOT_FOUND", `未知用户: ${parts[3]}`);
      return true;
    }
    await ctx.store.appendAudit(identity.actor, "user.status", { user_id: user.user_id, status: parsed.status });
    sendJson(res, 200, { user_id: user.user_id, status: user.status });
    return true;
  }

  // GET /v1/admin/devices
  if (req.method === "GET" && url.pathname === "/v1/admin/devices") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    const devices = (await ctx.store.listDevices()).map((d) => ({
      device_id: d.device_id,
      tenant_id: d.tenant_id,
      status: d.status,
      platform: d.platform,
      app_version: d.app_version,
      display_name: d.display_name,
      user_id: d.user_id,
      created_at: d.created_at,
    }));
    sendJson(res, 200, { devices });
    return true;
  }

  // GET /v1/admin/entitlements
  if (req.method === "GET" && url.pathname === "/v1/admin/entitlements") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    const deviceId = url.searchParams.get("device_id");
    const entitlements = deviceId
      ? await ctx.store.listEntitlements(deviceId)
      : await ctx.store.listAllEntitlements();
    sendJson(res, 200, { entitlements });
    return true;
  }

  // GET /v1/admin/packs（发布列表；含吊销）
  if (req.method === "GET" && url.pathname === "/v1/admin/packs") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    const releases = (await ctx.store.listReleases()).map((r) => ({
      pack_id: r.pack_id,
      version: r.version,
      status: r.status,
      digest: r.digest,
      signature_key_id: r.signature_key_id,
      min_desktop_version: r.min_desktop_version,
      created_at: r.created_at,
    }));
    sendJson(res, 200, { releases });
    return true;
  }

  // GET/POST /v1/admin/products
  if (url.pathname === "/v1/admin/products" && req.method === "GET") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    sendJson(res, 200, { products: await ctx.store.listProducts() });
    return true;
  }
  if (url.pathname === "/v1/admin/products" && req.method === "POST") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<{
      pack_id?: string;
      name?: string;
      description?: string;
      price_monthly_fen?: number;
      price_yearly_fen?: number;
      status?: "listed" | "unlisted";
    }>(req, res);
    if (!parsed) return true;
    if (
      typeof parsed.pack_id !== "string" ||
      typeof parsed.name !== "string" ||
      typeof parsed.price_monthly_fen !== "number" ||
      typeof parsed.price_yearly_fen !== "number"
    ) {
      sendError(res, 422, "INVALID_PRODUCT", "pack_id、name、price_monthly_fen、price_yearly_fen 必填");
      return true;
    }
    const product = await ctx.store.createProduct({
      pack_id: parsed.pack_id,
      name: parsed.name,
      description: parsed.description ?? "",
      price_monthly_fen: parsed.price_monthly_fen,
      price_yearly_fen: parsed.price_yearly_fen,
      status: parsed.status,
    });
    await ctx.store.appendAudit(identity.actor, "product.create", { product_id: product.product_id });
    sendJson(res, 201, product);
    return true;
  }

  // POST /v1/admin/products/{id}（更新）
  if (req.method === "POST" && parts.length === 4 && parts[2] === "products") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<{
      name?: string;
      description?: string;
      price_monthly_fen?: number;
      price_yearly_fen?: number;
      status?: "listed" | "unlisted";
    }>(req, res);
    if (!parsed) return true;
    const product = await ctx.store.updateProduct(parts[3]!, parsed);
    if (!product) {
      sendError(res, 404, "PRODUCT_NOT_FOUND", `未知商品: ${parts[3]}`);
      return true;
    }
    await ctx.store.appendAudit(identity.actor, "product.update", { product_id: product.product_id, patch: parsed });
    sendJson(res, 200, product);
    return true;
  }

  // GET /v1/admin/orders
  if (req.method === "GET" && url.pathname === "/v1/admin/orders") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    sendJson(res, 200, { orders: await ctx.store.listOrders(url.searchParams.get("user_id") ?? undefined) });
    return true;
  }

  // POST /v1/admin/orders/{id}/refund（退款入钱包）
  if (req.method === "POST" && parts.length === 5 && parts[2] === "orders" && parts[4] === "refund") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const order = await ctx.store.getOrder(parts[3]!);
    if (!order) {
      sendError(res, 404, "ORDER_NOT_FOUND", `未知订单: ${parts[3]}`);
      return true;
    }
    if (order.status !== "paid") {
      sendError(res, 409, "ORDER_NOT_PAID", `订单状态为 ${order.status}，无法退款`);
      return true;
    }
    await ctx.store.addWalletTransaction({
      user_id: order.user_id,
      type: "refund",
      amount_fen: order.amount_fen,
      order_id: order.order_id,
      remark: "管理端退款入余额",
    });
    const refunded = await ctx.store.updateOrder(order.order_id, { status: "refunded" });
    await ctx.store.appendAudit(identity.actor, "order.refund", { order_id: order.order_id, amount_fen: order.amount_fen });
    ctx.logger.info("order.refunded", { order_id: order.order_id });
    sendJson(res, 200, refunded);
    return true;
  }

  // POST /v1/admin/wallet/adjust（人工调账）
  if (req.method === "POST" && url.pathname === "/v1/admin/wallet/adjust") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<{ user_id?: string; amount_fen?: number; remark?: string }>(req, res);
    if (!parsed) return true;
    if (typeof parsed.user_id !== "string" || typeof parsed.amount_fen !== "number" || !Number.isInteger(parsed.amount_fen)) {
      sendError(res, 422, "INVALID_ADJUST", "user_id 和整数 amount_fen 必填");
      return true;
    }
    try {
      const txn = await ctx.store.addWalletTransaction({
        user_id: parsed.user_id,
        type: "adjust",
        amount_fen: parsed.amount_fen,
        remark: parsed.remark ?? "管理端调账",
      });
      await ctx.store.appendAudit(identity.actor, "wallet.adjust", {
        user_id: parsed.user_id,
        amount_fen: parsed.amount_fen,
        remark: parsed.remark,
      });
      sendJson(res, 200, txn);
    } catch (err) {
      if (err instanceof Error && err.message === "INSUFFICIENT_BALANCE") {
        sendError(res, 409, "INSUFFICIENT_BALANCE", "调账后余额为负，已拒绝");
        return true;
      }
      if (err instanceof Error && err.message.startsWith("Unknown user")) {
        sendError(res, 404, "USER_NOT_FOUND", err.message);
        return true;
      }
      throw err;
    }
    return true;
  }

  // GET /v1/admin/transactions
  if (req.method === "GET" && url.pathname === "/v1/admin/transactions") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    sendJson(res, 200, {
      transactions: await ctx.store.listTransactions(url.searchParams.get("user_id") ?? undefined),
    });
    return true;
  }

  // GET /v1/admin/audits
  if (req.method === "GET" && url.pathname === "/v1/admin/audits") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    sendJson(res, 200, { audits: await ctx.store.listAudits() });
    return true;
  }

  // GET /v1/admin/metrics（看板汇总）
  if (req.method === "GET" && url.pathname === "/v1/admin/metrics") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    const [users, devices, orders, releases] = await Promise.all([
      ctx.store.listUsers(),
      ctx.store.listDevices(),
      ctx.store.listOrders(),
      ctx.store.listReleases(),
    ]);
    const paid = orders.filter((o) => o.status === "paid");
    sendJson(res, 200, {
      users_total: users.length,
      devices_total: devices.length,
      orders_paid_total: paid.length,
      revenue_fen: paid.reduce((sum, o) => sum + o.amount_fen, 0),
      releases_total: releases.length,
    });
    return true;
  }

  return false;
}
