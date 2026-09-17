export interface Clock {
  now(): Date;
  nowIso(): string;
}

export function systemClock(): Clock {
  return {
    now: () => new Date(),
    nowIso: () => new Date().toISOString(),
  };
}
