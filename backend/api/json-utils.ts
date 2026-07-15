export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function numberField(record: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const candidate = record[name];
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const normalized = typeof candidate === "string"
      ? candidate.replaceAll(",", "").replace(/^\$/, "").trim()
      : candidate;
    const value = Number(normalized);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

export function stringField(record: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function collectRecords(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, output);
    return output;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    output.push(record);
    for (const nested of Object.values(record)) collectRecords(nested, output);
  }
  return output;
}

export function payloadRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}
