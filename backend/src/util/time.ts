export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | number): string {
  return new Date(value).toISOString();
}

export function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && value.includes("T");
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
