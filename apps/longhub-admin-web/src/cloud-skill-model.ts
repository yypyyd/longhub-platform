/** 云端 Skill 后台表单使用的无副作用模型。 */

export function normalizeSkillIds(value: string): string[] {
  return [...new Set(value.split(/[，,\s]+/u).map((item) => item.trim()).filter(Boolean))];
}

export function isValidCloudSkillPlanId(value: string): boolean {
  const normalized = value.trim();
  // Keep this in lock-step with CloudStore.createCloudSkillPlan and the
  // public adapter manifest schema.  In particular, underscores and a
  // leading digit are not accepted by the service and would otherwise make
  // the admin form look valid only to fail after submission.
  return normalized.length <= 128 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(normalized);
}

/** A billable Skill must use the canonical publisher.skill.name identifier. */
export function isValidCloudSkillId(value: string): boolean {
  const normalized = value.trim();
  return normalized.length <= 128 &&
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.skill\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u.test(normalized);
}

/** Validate a decimal Yuan input after conversion to integer fen. */
export function isValidYuanAmount(value: string, minimum = 0): boolean {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < minimum) return false;
  const fen = Math.round(amount * 100);
  return Number.isSafeInteger(fen) && fen >= 0;
}

/** Validate an integer quota/rate input before it is sent to the API. */
export function isValidPositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

export function cloudSkillSubscriptionStatusLabel(status: string): string {
  return ({
    active: "有效",
    cancelled: "已取消",
    expired: "已到期",
    refunded: "已退款",
    suspended: "已暂停",
  } as Record<string, string>)[status] ?? status;
}

export function cloudSkillOrderStatusLabel(status: string): string {
  return ({
    pending: "待确认",
    paid: "已完成",
    cancelled: "已取消",
    refunded: "已退款",
    failed: "失败",
  } as Record<string, string>)[status] ?? status;
}
