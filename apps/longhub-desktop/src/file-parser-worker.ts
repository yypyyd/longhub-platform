import { parseStrictAttachment } from "./file-capability.js";

function main(): void {
  const [path, maxBytesRaw, maxCharsRaw] = process.argv.slice(2);
  const maxBytes = Number(maxBytesRaw);
  const maxChars = Number(maxCharsRaw);
  if (!path) throw new Error("缺少解析文件");
  process.stdout.write(`${JSON.stringify(parseStrictAttachment(path, maxBytes, maxChars))}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
