import { execFile } from "node:child_process";
import type { ParsedAttachment } from "./file-capability.js";

export interface IsolatedFileParserOptions {
  readonly nodeExecutable: string;
  readonly workerScript: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxChars?: number;
}

/** 每次解析使用短命子进程；超时、崩溃、超量输出都只失败当前附件。 */
export class IsolatedFileParser {
  constructor(private readonly options: IsolatedFileParserOptions) {}

  parse(path: string): Promise<ParsedAttachment> {
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const maxBytes = this.options.maxBytes ?? 5 * 1024 * 1024;
    const maxChars = this.options.maxChars ?? 200_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("解析超时配置无效");
    return new Promise((resolve, reject) => {
      execFile(this.options.nodeExecutable, [this.options.workerScript, path, String(maxBytes), String(maxChars)], {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: Math.min(4 * 1024 * 1024, maxChars * 4 + 4_096),
        env: { NODE_ENV: "production", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      }, (error, stdout) => {
        if (error) {
          reject(new Error(error.killed ? "附件解析超时" : "附件解析失败或解析器崩溃"));
          return;
        }
        try {
          const value = JSON.parse(stdout) as ParsedAttachment;
          if (!value || !["text", "json", "csv", "markdown"].includes(value.kind) ||
            typeof value.text !== "string" || typeof value.truncated !== "boolean" || value.text.length > maxChars) {
            throw new Error("解析响应无效");
          }
          resolve(value);
        } catch {
          reject(new Error("附件解析器返回无效结果"));
        }
      });
    });
  }
}
