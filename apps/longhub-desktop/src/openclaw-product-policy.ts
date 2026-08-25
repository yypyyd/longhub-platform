import { buildOpenClawProductCss, OPENCLAW_COMPAT_CONTRACT } from "@longhub/openclaw-compat";

/** 龙枢成品客户端开放经过审查的 OpenClaw 原生产品页，不暴露控制面与任意执行入口。 */
const ROUTES = OPENCLAW_COMPAT_CONTRACT.routes;

function normalizedPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function productBasePath(productPathname: string): string {
  const productPath = normalizedPathname(productPathname);
  if (productPath === ROUTES.chatPath) return "";
  if (!productPath.endsWith(ROUTES.chatPath)) return productPath;
  return productPath.slice(0, -ROUTES.chatPath.length);
}

export function isForbiddenOpenClawRoute(target: string, controlUiUrl: string): boolean {
  try {
    const url = new URL(target);
    const product = new URL(controlUiUrl);
    if (url.origin !== product.origin) return false;
    const path = normalizedPathname(url.pathname);
    return ROUTES.forbiddenPathFragments.some((fragment) => path.includes(fragment)) ||
      ROUTES.forbiddenSuffixes.some((suffix) => path.endsWith(suffix));
  } catch {
    return false;
  }
}

/** 主窗口只允许留在当前 Gateway 的已审查原生页面；自定义安装 scheme 由 Main 单独解析。 */
export function isAllowedOpenClawNavigation(target: string, controlUiUrl: string): boolean {
  try {
    const url = new URL(target);
    const product = new URL(controlUiUrl);
    const path = normalizedPathname(url.pathname);
    const basePath = productBasePath(product.pathname);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === product.origin &&
      ROUTES.ordinaryUserPathSuffixes.some((suffix) => path === `${basePath}${suffix}`) &&
      !isForbiddenOpenClawRoute(target, controlUiUrl)
    );
  } catch {
    return false;
  }
}

export const OPENCLAW_PRODUCT_CSS = buildOpenClawProductCss();
