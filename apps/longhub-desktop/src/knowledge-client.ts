const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export interface AgentKnowledgeCitation {
  readonly agentId: string;
  readonly documentId: string;
  readonly title: string;
  readonly sourceLabel: string;
  readonly snippet: string;
}

export interface KnowledgeClientOptions {
  readonly baseUrl: string;
  readonly deviceToken: string;
  readonly fetchImpl?: typeof fetch;
}

/** Cloud 按设备身份决定 tenant，Desktop 再绑定当前 Agent，引用不进入跨 Agent 缓存。 */
export class AgentKnowledgeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KnowledgeClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
      throw new Error("知识服务必须使用 HTTPS 或回环地址");
    }
    if (!options.deviceToken) throw new Error("知识查询缺少设备凭据");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async query(agentId: string, query: string, limit = 5): Promise<readonly AgentKnowledgeCitation[]> {
    if (!ID.test(agentId)) throw new Error("知识查询 Agent 无效");
    const normalized = query.trim();
    if (normalized.length < 2 || normalized.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("知识查询边界无效");
    }
    const response = await this.fetchImpl(new URL("/v1/knowledge/query", this.options.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ query: normalized, limit }),
    });
    if (!response.ok) throw new Error(`知识查询失败 (${response.status})`);
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).sort().join("|") !== "citations" || !Array.isArray((body as { citations?: unknown }).citations)) {
      throw new Error("知识查询响应无效");
    }
    return (body as { citations: unknown[] }).citations.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("知识引用无效");
      const item = value as Record<string, unknown>;
      if (Object.keys(item).sort().join("|") !== "document_id|score|snippet|source_label|title" ||
        typeof item.document_id !== "string" || !ID.test(item.document_id) || typeof item.title !== "string" ||
        typeof item.source_label !== "string" || typeof item.snippet !== "string" || typeof item.score !== "number" ||
        item.title.length > 200 || item.source_label.length > 200 || item.snippet.length > 1_000) {
        throw new Error("知识引用字段无效");
      }
      return {
        agentId,
        documentId: item.document_id,
        title: item.title,
        sourceLabel: item.source_label,
        snippet: item.snippet,
      };
    });
  }
}
