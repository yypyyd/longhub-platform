export interface ModelInputCapabilities {
  readonly input: readonly ["text"] | readonly ["text", "image"];
  readonly textExtraction: boolean;
  readonly imageUnderstanding: boolean;
}

export async function fetchModelInputCapabilities(options: {
  baseUrl: string;
  deviceToken: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelInputCapabilities> {
  const url = new URL(options.baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new Error("模型能力服务必须使用 HTTPS 或回环地址");
  }
  const response = await (options.fetchImpl ?? fetch)(new URL("/v1/client/model-capabilities", url), {
    headers: { authorization: `Bearer ${options.deviceToken}` },
  });
  if (!response.ok) throw new Error(`模型能力查询失败 (${response.status})`);
  const body = await response.json() as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("模型能力响应无效");
  const raw = body as Record<string, unknown>;
  const fileInputs = raw.file_inputs;
  if (Object.keys(raw).sort().join("|") !== "file_inputs|input|model_id|schema_version" ||
    raw.schema_version !== "longhub/model-capabilities/v1" || raw.model_id !== "longhub-default" ||
    !Array.isArray(raw.input) || (raw.input.length !== 1 && raw.input.length !== 2) || raw.input[0] !== "text" ||
    (raw.input.length === 2 && raw.input[1] !== "image") || !fileInputs || typeof fileInputs !== "object" ||
    Array.isArray(fileInputs) || Object.keys(fileInputs).sort().join("|") !== "image_understanding|text_extraction" ||
    typeof (fileInputs as Record<string, unknown>).text_extraction !== "boolean" ||
    typeof (fileInputs as Record<string, unknown>).image_understanding !== "boolean" ||
    (fileInputs as Record<string, unknown>).image_understanding !== raw.input.includes("image")) {
    throw new Error("模型能力响应字段无效");
  }
  return {
    input: [...raw.input] as ["text"] | ["text", "image"],
    textExtraction: (fileInputs as Record<string, boolean>).text_extraction,
    imageUnderstanding: (fileInputs as Record<string, boolean>).image_understanding,
  };
}

/** 离线或旧 Cloud 安全降级为文本；绝不根据文件扩展名自行推断视觉支持。 */
export async function resolveModelInputCapabilities(options: Parameters<typeof fetchModelInputCapabilities>[0]): Promise<ModelInputCapabilities> {
  try {
    return await fetchModelInputCapabilities(options);
  } catch {
    return { input: ["text"], textExtraction: true, imageUnderstanding: false };
  }
}
