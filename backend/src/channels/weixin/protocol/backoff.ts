export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** 抖动比例（0..1）。默认 0.2：把重试打散，避免同步风暴 */
  jitterRatio?: number;
  random?: () => number;
}

/** 指数退避 + 抖动。attempt 从 0 开始。 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1_000;
  const max = options.maxMs ?? 60_000;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const random = options.random ?? Math.random;
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
