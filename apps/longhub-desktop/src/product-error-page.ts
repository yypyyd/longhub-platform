export type ProductStatusCode =
  | "GATEWAY_RECONNECTING"
  | "CLOUD_UNREACHABLE"
  | "DEVICE_CREDENTIAL_INVALID"
  | "ACTIVATION_REQUIRED"
  | "MODEL_NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_CONFIG_ERROR"
  | "GATEWAY_RESTART_EXHAUSTED"
  | "GATEWAY_START_TIMEOUT"
  | "STORAGE_QUOTA_EXCEEDED"
  | "STORAGE_SPACE_LOW"
  | "WEBUI_LOAD_FAILED";

interface ProductStatusDefinition {
  publicCode: string;
  title: string;
  message: string;
  action: string;
  pending?: boolean;
}

const STATUS_DEFINITIONS: Readonly<Record<ProductStatusCode, ProductStatusDefinition>> = {
  GATEWAY_RECONNECTING: {
    publicCode: "LH-GW-001",
    title: "正在恢复聊天服务",
    message: "龙枢正在自动重新连接本机聊天服务，你不需要修改任何模型或连接配置。",
    action: "恢复完成后会自动回到聊天界面。",
    pending: true,
  },
  CLOUD_UNREACHABLE: {
    publicCode: "LH-CL-001",
    title: "暂时无法连接龙枢服务",
    message: "请检查网络连接后稍候重试。你的模型和智能体配置仍由后台统一管理。",
    action: "若网络正常但持续出现此页，请联系管理员并提供下方错误码。",
  },
  DEVICE_CREDENTIAL_INVALID: {
    publicCode: "LH-AU-001",
    title: "设备凭据已失效",
    message: "当前设备凭据无法继续使用，龙枢不会让你手工配置模型或密钥。",
    action: "请联系管理员重新授权此设备。",
  },
  ACTIVATION_REQUIRED: {
    publicCode: "LH-AU-002",
    title: "设备需要授权",
    message: "当前设备尚未获得龙枢使用权限。",
    action: "请使用管理员提供的授权码完成激活。",
  },
  MODEL_NOT_CONFIGURED: {
    publicCode: "LH-MD-001",
    title: "后台尚未配置可用模型",
    message: "模型由龙枢后台统一配置，客户端不需要也不能自行选择模型。",
    action: "请联系管理员完成后台模型配置。",
  },
  RATE_LIMITED: {
    publicCode: "LH-UP-001",
    title: "请求较多，请稍候",
    message: "当前服务请求已达到临时限额。",
    action: "请稍后再试；若持续出现，请联系管理员检查额度和限流策略。",
  },
  SERVICE_UNAVAILABLE: {
    publicCode: "LH-UP-002",
    title: "龙枢服务暂时不可用",
    message: "后台或上游服务当前未能正常响应。",
    action: "请稍后重新打开龙枢；若持续出现，请联系管理员并提供下方错误码。",
  },
  GATEWAY_CONFIG_ERROR: {
    publicCode: "LH-GW-002",
    title: "聊天服务配置异常",
    message: "龙枢检测到本机聊天服务配置无法安全启动，因此已停止无意义的自动重试。",
    action: "请重新打开龙枢；若仍无法恢复，请联系管理员并提供下方错误码。",
  },
  GATEWAY_RESTART_EXHAUSTED: {
    publicCode: "LH-GW-003",
    title: "聊天服务连续恢复失败",
    message: "龙枢已按限频策略尝试恢复，但本机聊天服务仍未正常运行。",
    action: "请重新打开龙枢；若仍无法恢复，请联系管理员并提供下方错误码。",
  },
  GATEWAY_START_TIMEOUT: {
    publicCode: "LH-GW-004",
    title: "聊天服务启动超时",
    message: "本机聊天服务未在安全等待时间内提供可用的聊天页面。",
    action: "请重新打开龙枢；若仍无法恢复，请联系管理员并提供下方错误码。",
  },
  STORAGE_QUOTA_EXCEEDED: {
    publicCode: "LH-ST-001",
    title: "龙枢本机存储空间不足",
    message: "龙枢专属状态已达到安全上限。为保护聊天记录和智能体数据，客户端没有自动删除这些内容。",
    action: "请联系管理员导出诊断信息并处理磁盘空间后，再重新打开龙枢。",
  },
  STORAGE_SPACE_LOW: {
    publicCode: "LH-ST-002",
    title: "磁盘剩余空间不足",
    message: "龙枢检测到本机磁盘空间不足，已暂停启动以避免聊天记录或智能体状态写入不完整。",
    action: "请至少释放 256 MiB 磁盘空间，然后重新打开龙枢。",
  },
  WEBUI_LOAD_FAILED: {
    publicCode: "LH-UI-001",
    title: "聊天界面加载失败",
    message: "本机聊天服务已经启动，但聊天界面暂时无法显示。",
    action: "请重新打开龙枢；若仍无法恢复，请联系管理员并提供下方错误码。",
  },
};

function isProductStatusCode(value: string): value is ProductStatusCode {
  return Object.prototype.hasOwnProperty.call(STATUS_DEFINITIONS, value);
}

function errorFacts(error: unknown): { code: string; message: string; status?: number } {
  if (!error || typeof error !== "object") {
    return { code: "", message: String(error ?? "").toUpperCase() };
  }
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown; statusCode?: unknown };
  const rawStatus = candidate.status ?? candidate.statusCode;
  return {
    code: typeof candidate.code === "string" ? candidate.code.toUpperCase() : "",
    message: typeof candidate.message === "string" ? candidate.message.toUpperCase() : "",
    ...(typeof rawStatus === "number" ? { status: rawStatus } : {}),
  };
}

/** 只提取错误类别；原始异常、URL、响应正文和本机路径绝不进入用户页面。 */
export function classifyProductError(
  error: unknown,
  fallback: ProductStatusCode = "SERVICE_UNAVAILABLE",
): ProductStatusCode {
  const { code, message, status } = errorFacts(error);
  const combined = `${code} ${message}`;
  if (isProductStatusCode(code)) return code;
  if (/(?:ENOSPC|EDQUOT|NO_SPACE|DISK_FULL|磁盘.*(?:不足|已满)|空间不足)/.test(combined)) {
    return "STORAGE_SPACE_LOW";
  }
  if (status === 429 || /(?:RATE_LIMIT|TOO_MANY_REQUESTS|HTTP\s*429|\[429\])/.test(combined)) {
    return "RATE_LIMITED";
  }
  if (
    status === 401 ||
    /(?:UNAUTHORIZED|INVALID_(?:DEVICE_)?TOKEN|DEVICE_CREDENTIAL|凭据.*(?:失效|无效)|HTTP\s*401|\[401\])/.test(combined)
  ) return "DEVICE_CREDENTIAL_INVALID";
  if (
    status === 403 ||
    /(?:ACTIVATION_(?:REQUIRED|REVOKED|EXPIRED)|NOT_ACTIVATED|设备.*(?:未激活|未授权)|HTTP\s*403|\[403\])/.test(combined)
  ) return "ACTIVATION_REQUIRED";
  if (/(?:MODEL_NOT_CONFIGURED|NO_MODEL|后台.*未配置.*模型|未配置.*MODEL|模型.*未配置)/.test(combined)) {
    return "MODEL_NOT_CONFIGURED";
  }
  const networkCode = /(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)/;
  const networkMessage = /(?:FETCH FAILED|ABORTERROR|网络|无法连接)/;
  if (networkCode.test(combined) || networkMessage.test(combined)) return "CLOUD_UNREACHABLE";
  if (status !== undefined && status >= 500) return "SERVICE_UNAVAILABLE";
  if (/(?:HTTP\s*5\d\d|\[5\d\d\]|UPSTREAM|SERVICE_UNAVAILABLE)/.test(combined)) {
    return "SERVICE_UNAVAILABLE";
  }
  return fallback;
}

export function productStatusDefinition(code: ProductStatusCode): Readonly<ProductStatusDefinition> {
  return STATUS_DEFINITIONS[code];
}

/** 固定白名单页面：调用方只能传错误码，不能把上游诊断文本拼入 HTML。 */
export function productStatusPage(code: ProductStatusCode): string {
  const status = STATUS_DEFINITIONS[code];
  const pendingClass = status.pending ? " pending" : "";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${status.title}</title><style>
body{
  margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f5f7;color:#1d1d1f;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif
}
main{
  width:min(560px,calc(100vw - 64px));padding:32px;border:1px solid #ddd;border-radius:18px;
  background:#fff;box-shadow:0 12px 40px #00000014
}
.mark{
  width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:#fef3f2;
  color:#b42318;font-size:22px;font-weight:700
}
.mark.pending{background:#eef4ff;color:#175cd3}
h1{margin:18px 0 12px;font-size:24px}
p{line-height:1.65;color:#555;margin:8px 0}
.code{
  display:inline-block;margin-top:18px;padding:7px 10px;border-radius:9px;background:#f2f2f4;
  color:#555;font:600 13px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.04em
}
.diagnostic{
  display:inline-block;margin-left:10px;color:#175cd3;font:600 13px -apple-system,BlinkMacSystemFont,
  'Segoe UI','Microsoft YaHei',sans-serif;text-decoration:none
}
.diagnostic:hover{text-decoration:underline}
</style></head><body><main>
<div class="mark${pendingClass}">${status.pending ? "…" : "!"}</div>
<h1>${status.title}</h1><p>${status.message}</p><p>${status.action}</p>
<span class="code">${status.publicCode}</span>
<a class="diagnostic" href="longhub-diagnostics://export/">导出诊断信息</a>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
