/** 契约与测试工具占位入口。 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}
