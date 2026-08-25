/** LongHub Manager 发布表单使用的无副作用命名与版本校验。 */

const MANAGER_VERSION_PATTERN = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u;

export function isValidManagerVersion(value: string): boolean {
  return MANAGER_VERSION_PATTERN.test(value);
}

export function managerInstallerFilename(version: string): string {
  if (!isValidManagerVersion(version)) throw new Error("Manager 版本必须是规范的 x.y.z");
  return `LongHub-Manager-Setup-${version}.exe`;
}

export function isValidManagerInstallerFilename(version: string, filename: string): boolean {
  return isValidManagerVersion(version) && filename === managerInstallerFilename(version);
}
