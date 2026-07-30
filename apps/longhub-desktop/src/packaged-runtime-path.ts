import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * Resolve a file that must be consumed by the standalone Node runtime.
 * Electron can read app.asar directly, but the bundled node.exe cannot, so
 * explicitly unpacked runtime files live under the sibling app.asar.unpacked.
 */
export function resolveExternalRuntimePath(
  appRoot: string,
  relativePath: string,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (!appRoot || !relativePath || isAbsolute(relativePath)) {
    throw new Error("外置运行时路径必须是应用内相对路径");
  }
  const normalized = relative(appRoot, join(appRoot, relativePath));
  if (!normalized || normalized.startsWith("..") || isAbsolute(normalized)) {
    throw new Error(`外置运行时路径越界: ${relativePath}`);
  }
  const physicalRoot = appRoot.toLowerCase().endsWith(".asar")
    ? `${appRoot}.unpacked`
    : appRoot;
  const resolved = join(physicalRoot, normalized);
  if (!pathExists(resolved)) {
    throw new Error(`外置运行时文件不存在: ${resolved}`);
  }
  return resolved;
}
