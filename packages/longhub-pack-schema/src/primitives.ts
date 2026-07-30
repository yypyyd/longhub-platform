import { z } from "zod";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function isSafePackPath(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(" ") &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !WINDOWS_RESERVED_NAME.test(segment),
  );
}

/** 语义化版本，如 1.3.0 */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "必须是语义化版本号，如 1.3.0");

/** 主次版本，如 1.0 */
export const majorMinorSchema = z
  .string()
  .regex(/^\d+\.\d+$/, "必须是主次版本号，如 1.0");

/** 权限声明，如 connector:hr-api:read */
export const permissionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(:[a-z0-9_.-]+)+$/, "权限格式：<类别>:<资源>[:<动作>]");

export const packIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "ID 使用点分小写命名，如 longhub.hr-suite");

/** Pack 内部相对路径；禁止绝对路径、反斜杠、盘符、路径穿越和 Windows 设备名。 */
export const packRelativePathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(isSafePackPath, "必须是安全的 Pack 内部相对路径");
