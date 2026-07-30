import { validatePackContent, type PackFile } from "@longhub/pack-schema";

export function scanThirdPartyPack(pack: PackFile): string[] {
  const findings: string[] = [];
  const validated = validatePackContent(pack.manifest, pack.files);
  if (!validated.ok) findings.push("PACK_SCHEMA_INVALID");
  const patterns: Array<[string, RegExp]> = [
    ["PRIVATE_KEY_MATERIAL", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
    ["DYNAMIC_CODE_EXECUTION", /\b(?:eval|Function)\s*\(/],
    ["SHELL_EXECUTION", /(?:child_process|powershell|cmd\.exe|\/bin\/sh)/i],
    ["INSECURE_REMOTE_URL", /http:\/\//i],
    ["PATH_TRAVERSAL", /(?:^|[\\/])\.\.(?:[\\/]|$)/],
  ];
  for (const [path, content] of Object.entries(pack.files)) {
    for (const [code, pattern] of patterns) if (pattern.test(path) || pattern.test(content)) findings.push(code);
  }
  return [...new Set(findings)].sort();
}
