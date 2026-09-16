/** Typed accessors for the loosely-typed `options` block of providers.yaml. */
export function optString(o: Record<string, unknown>, key: string, fallback: string): string {
  const v = o[key];
  return typeof v === "string" && v.trim() ? v : fallback;
}
export function optNumber(o: Record<string, unknown>, key: string, fallback: number): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
export function optStringArray(o: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const v = o[key];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fallback;
}
export function optRecord(o: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = o[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
