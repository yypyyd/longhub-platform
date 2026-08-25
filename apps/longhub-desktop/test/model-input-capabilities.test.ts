import { describe, expect, it } from "vitest";
import { buildOpenClawConfig } from "../src/openclaw-runtime.js";
import { fetchModelInputCapabilities, resolveModelInputCapabilities } from "../src/model-input-capabilities.js";

const runtime = {
  provider_id: "longhub" as const,
  base_path: "/v1/model" as const,
  model_id: "longhub-default" as const,
  display_name: "龙枢模型",
  api_type: "openai-completions" as const,
  context_window: 128_000,
  max_tokens: 8_192,
  allow_user_model_selection: false as const,
};

describe("模型输入 capability 协商", () => {
  it("Cloud 明确声明视觉后才写入 OpenClaw image input", async () => {
    const capabilities = await fetchModelInputCapabilities({
      baseUrl: "https://cloud.example",
      deviceToken: "device-token",
      fetchImpl: async () => Response.json({
        schema_version: "longhub/model-capabilities/v1",
        model_id: "longhub-default",
        input: ["text", "image"],
        file_inputs: { text_extraction: true, image_understanding: true },
      }),
    });
    const config = buildOpenClawConfig("https://cloud.example", runtime, "C:\\LongHub", capabilities.input) as any;
    expect(config.models.providers.longhub.models[0].input).toEqual(["text", "image"]);
  });

  it("查询失败安全降级为文本，不根据文件自行推断视觉", async () => {
    const capabilities = await resolveModelInputCapabilities({
      baseUrl: "https://cloud.example",
      deviceToken: "device-token",
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    expect(capabilities).toEqual({ input: ["text"], textExtraction: true, imageUnderstanding: false });
    const config = buildOpenClawConfig("https://cloud.example", runtime, "C:\\LongHub", capabilities.input) as any;
    expect(config.models.providers.longhub.models[0].input).toEqual(["text"]);
  });
});
