/**
 * 权限确认策略（方案 §10.2）：读类操作免确认，
 * 写文件、发送消息、修改企业数据、付款和删除等变更操作必须人工确认。
 */
const READ_ONLY_ACTIONS = new Set(["read", "list", "get", "query", "search"]);

/** 返回本次请求中需要人工确认的权限子集；为空表示可直接执行 */
export function permissionsRequiringConfirmation(
  permissions: readonly string[],
): string[] {
  return permissions.filter((permission) => {
    const segments = permission.split(":");
    const action = segments[segments.length - 1] ?? "";
    return !READ_ONLY_ACTIONS.has(action);
  });
}
