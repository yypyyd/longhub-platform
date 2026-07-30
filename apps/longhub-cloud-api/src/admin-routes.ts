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
import { generateActivationCode, publicActivationCode } from "./activation-code.js";
import { bearerToken, readJson, sendError, sendJson } from "./http-util.js";
import type {
  AdminRole,
  ClientTelemetryAggregateRecord,
  CloudStore,
  ModelRequestAggregateRecord,
} from "./store.js";

export interface OperationalMetrics {
  window_hours: 24;
  client_starts: number;
  previous_exit_clean: number;
  previous_exit_unclean: number;
  crash_rate: number | null;
  model_requests: number;
  model_successes: number;
  model_success_rate: number | null;
  model_latency_buckets: Record<ModelRequestAggregateRecord["latency_bucket"], number>;
  update_healthy: number;
  update_failed: number;
  update_rollback: number;
  update_success_rate: number | null;
  product_errors: number;
  top_product_errors: Array<{ code: string; count: number }>;
  desktop_versions: Array<{ version: string; count: number }>;
}

export function buildOperationalMetrics(
  clientRows: readonly ClientTelemetryAggregateRecord[],
  modelRows: readonly ModelRequestAggregateRecord[],
  now = new Date(),
): OperationalMetrics {
  const cutoff = now.getTime() - 24 * 60 * 60_000;
  const clients = clientRows.filter((row) => Date.parse(row.bucket_start) >= cutoff && Date.parse(row.bucket_start) <= now.getTime());
  const models = modelRows.filter((row) => Date.parse(row.bucket_start) >= cutoff && Date.parse(row.bucket_start) <= now.getTime());
  const sumClient = (type: ClientTelemetryAggregateRecord["event_type"], value?: string): number =>
    clients.filter((row) => row.event_type === type && (value === undefined || row.value === value))
      .reduce((total, row) => total + row.count, 0);
  const clean = sumClient("previous_exit", "clean");
  const unclean = sumClient("previous_exit", "unclean");
  const modelRequests = models.reduce((total, row) => total + row.count, 0);
  const modelSuccesses = models.filter((row) => row.outcome === "success").reduce((total, row) => total + row.count, 0);
  const updateHealthy = sumClient("client_update_result", "healthy");
  const updateFailed = sumClient("client_update_result", "failed");
  const updateRollback = sumClient("client_update_result", "rollback_completed");
  const latencyBuckets: OperationalMetrics["model_latency_buckets"] = {
    lt_1s: 0,
    "1_to_3s": 0,
    "3_to_10s": 0,
    "10_to_30s": 0,
    gte_30s: 0,
  };
  for (const row of models) latencyBuckets[row.latency_bucket] += row.count;
  const errorCounts = new Map<string, number>();
  const versionCounts = new Map<string, number>();
  for (const row of clients) {
    if (row.event_type === "product_error") errorCounts.set(row.value, (errorCounts.get(row.value) ?? 0) + row.count);
    if (row.event_type === "client_started") versionCounts.set(row.desktop_version, (versionCounts.get(row.desktop_version) ?? 0) + row.count);
  }
  const sortedCounts = (values: Map<string, number>, label: "code" | "version") =>
    [...values].map(([key, count]) => ({ [label]: key, count })).sort((a, b) => b.count - a.count || String(a[label]).localeCompare(String(b[label])));
  const previousTotal = clean + unclean;
  const updateTotal = updateHealthy + updateFailed + updateRollback;
  return {
    window_hours: 24,
    client_starts: sumClient("client_started"),
    previous_exit_clean: clean,
    previous_exit_unclean: unclean,
    crash_rate: previousTotal > 0 ? unclean / previousTotal : null,
    model_requests: modelRequests,
    model_successes: modelSuccesses,
    model_success_rate: modelRequests > 0 ? modelSuccesses / modelRequests : null,
    model_latency_buckets: latencyBuckets,
    update_healthy: updateHealthy,
    update_failed: updateFailed,
    update_rollback: updateRollback,
    update_success_rate: updateTotal > 0 ? updateHealthy / updateTotal : null,
    product_errors: [...errorCounts.values()].reduce((total, count) => total + count, 0),
    top_product_errors: sortedCounts(errorCounts, "code").slice(0, 5) as Array<{ code: string; count: number }>,
    desktop_versions: sortedCounts(versionCounts, "version") as Array<{ version: string; count: number }>,
  };
}

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
  if (token === ctx.adminToken) return { actor: "static-admin", role: "super" };
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
      activation_code_id: d.activation_code_id,
      activated_at: d.activated_at,
      last_seen_at: d.last_seen_at,
      last_model_success_at: d.last_model_success_at,
      last_error_code: d.last_error_code,
      credential_rotated_at: d.credential_rotated_at,
      min_required_version: d.min_required_version,
      rollout_group: d.rollout_group,
      created_at: d.created_at,
    }));
    sendJson(res, 200, { devices });
    return true;
  }

  if (req.method === "POST" && parts.length === 4 && parts[2] === "devices") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<{ status?: "active" | "revoked"; min_required_version?: string | null; rollout_group?: string | null }>(req, res);
    if (!parsed) return true;
    const minVersion = parsed.min_required_version === null ? undefined : parsed.min_required_version;
    const group = parsed.rollout_group === null ? undefined : parsed.rollout_group;
    if ((parsed.status && !["active", "revoked"].includes(parsed.status)) ||
      (minVersion && !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(minVersion)) ||
      (group && !/^[A-Za-z0-9._-]{1,64}$/.test(group))) {
      sendError(res, 422, "INVALID_DEVICE_POLICY", "设备状态、最低版本或灰度分组无效");
      return true;
    }
    const updated = await ctx.store.updateDeviceOperations(parts[3]!, {
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(Object.hasOwn(parsed, "min_required_version") ? { min_required_version: minVersion } : {}),
      ...(Object.hasOwn(parsed, "rollout_group") ? { rollout_group: group } : {}),
    });
    if (!updated) {
      sendError(res, 404, "DEVICE_NOT_FOUND", "设备不存在");
      return true;
    }
    await ctx.store.appendAudit(identity.actor, "device.policy.update", { device_id: updated.device_id, status: updated.status, min_required_version: updated.min_required_version, rollout_group: updated.rollout_group });
    sendJson(res, 200, { device: { ...updated, device_token: undefined, device_fingerprint: undefined } });
    return true;
  }

  if (req.method === "POST" && parts.length === 5 && parts[2] === "devices" && parts[4] === "rotate-credential") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const token = newToken("dt");
    const updated = await ctx.store.updateDeviceOperations(parts[3]!, { device_token: token, credential_rotated_at: new Date().toISOString() });
    if (!updated) {
      sendError(res, 404, "DEVICE_NOT_FOUND", "设备不存在");
      return true;
    }
    await ctx.store.appendAudit(identity.actor, "device.credential.rotate", { device_id: updated.device_id });
    sendJson(res, 200, { device_id: updated.device_id, device_token: token, credential_rotated_at: updated.credential_rotated_at });
    return true;
  }

  // GET/POST /v1/admin/activation-codes（明文只在创建响应返回一次）
  if (url.pathname === "/v1/admin/activation-codes" && req.method === "GET") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    sendJson(res, 200, {
      activation_codes: (await ctx.store.listActivationCodes()).map(publicActivationCode),
    });
    return true;
  }
  if (url.pathname === "/v1/admin/activation-codes" && req.method === "POST") {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<{
      tenant_id?: string;
      label?: string;
      max_uses?: number;
      expires_in_days?: number;
      pack_ids?: string[];
    }>(req, res);
    if (!parsed) return true;
    const tenantId = parsed.tenant_id?.trim() || "tenant-default";
    const label = parsed.label?.trim();
    const maxUses = parsed.max_uses ?? 1;
    const expiresInDays = parsed.expires_in_days ?? 365;
    const packIds = parsed.pack_ids ?? [];
    if (
      !/^[a-zA-Z0-9._-]{1,128}$/.test(tenantId) ||
      (label !== undefined && label.length > 200) ||
      !Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10_000 ||
      !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3_650 ||
      !Array.isArray(packIds) || packIds.length > 32 ||
      packIds.some((packId) => typeof packId !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(packId))
    ) {
      sendError(res, 422, "INVALID_ACTIVATION_CODE", "授权码参数无效");
      return true;
    }
    const generated = generateActivationCode();
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000).toISOString();
    const record = await ctx.store.createActivationCode({
      tenant_id: tenantId,
      code_hash: generated.codeHash,
      code_hint: generated.codeHint,
      label,
      max_uses: maxUses,
      pack_ids: [...new Set(packIds)],
      expires_at: expiresAt,
    });
    await ctx.store.appendAudit(identity.actor, "activation-code.create", {
      activation_code_id: record.activation_code_id,
      max_uses: record.max_uses,
      pack_ids: record.pack_ids,
      expires_at: record.expires_at,
    });
    sendJson(res, 201, { activation_code: publicActivationCode(record), code: generated.code });
    return true;
  }

  // POST /v1/admin/activation-codes/{id}/revoke
  if (
    req.method === "POST" && parts.length === 5 && parts[2] === "activation-codes" && parts[4] === "revoke"
  ) {
    const identity = await requireAdmin(ctx, req, res, { write: true });
    if (!identity) return true;
    const record = await ctx.store.revokeActivationCode(parts[3]!);
    if (!record) {
      sendError(res, 404, "ACTIVATION_CODE_NOT_FOUND", "授权码不存在");
      return true;
    }
    await ctx.store.appendAudit(identity.actor, "activation-code.revoke", {
      activation_code_id: record.activation_code_id,
    });
    sendJson(res, 200, { activation_code: publicActivationCode(record) });
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

  if (req.method === "GET" && url.pathname === "/v1/admin/model-usage") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    sendJson(res, 200, { usage: await ctx.store.listModelUsage() });
    return true;
  }

  // GET /v1/admin/metrics（看板汇总）
  if (req.method === "GET" && url.pathname === "/v1/admin/metrics") {
    if (!(await requireAdmin(ctx, req, res, { write: false }))) return true;
    const [users, devices, orders, releases, clientTelemetry, modelMetrics, modelUsage] = await Promise.all([
      ctx.store.listUsers(),
      ctx.store.listDevices(),
      ctx.store.listOrders(),
      ctx.store.listReleases(),
      ctx.store.listClientTelemetry(),
      ctx.store.listModelRequestMetrics(),
      ctx.store.listModelUsage(),
    ]);
    const paid = orders.filter((o) => o.status === "paid");
    sendJson(res, 200, {
      users_total: users.length,
      devices_total: devices.length,
      orders_paid_total: paid.length,
      revenue_fen: paid.reduce((sum, o) => sum + o.amount_fen, 0),
      releases_total: releases.length,
      operations: buildOperationalMetrics(clientTelemetry, modelMetrics),
      model_usage: modelUsage.filter((row) => row.period === "month").reduce((summary, row) => ({
        requests: summary.requests + row.request_count,
        input_tokens: summary.input_tokens + row.input_tokens,
        output_tokens: summary.output_tokens + row.output_tokens,
        cache_tokens: summary.cache_tokens + row.cache_tokens,
        estimated_tokens: summary.estimated_tokens + row.estimated_tokens,
        cost_microunits: summary.cost_microunits + row.cost_microunits,
      }), { requests: 0, input_tokens: 0, output_tokens: 0, cache_tokens: 0, estimated_tokens: 0, cost_microunits: 0 }),
    });
    return true;
  }

  return false;
}
