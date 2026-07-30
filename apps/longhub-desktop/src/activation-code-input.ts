export function normalizeActivationInput(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  const compact = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^LH[A-F0-9]{16}$/.test(compact)) return undefined;
  return `LH-${compact.slice(2).match(/.{4}/g)!.join("-")}`;
}
