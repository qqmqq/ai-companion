import type { Clock } from "../../src/core/ports/clock.ts";

/**
 * 假时钟：调度器/主动消息的全部测试都靠它推进时间，
 * 不依赖真实系统时间、不 sleep、不 setTimeout。
 */
export interface FakeClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
  /** 设置到本地时间的某个时刻（用于静音时段等本地时间语义） */
  setLocal(hour: number, minute: number, dayOffset?: number): void;
}

export function createFakeClock(startIso = "2026-03-01T09:00:00.000Z"): FakeClock {
  let current = new Date(startIso);
  return {
    now: () => new Date(current.getTime()),
    nowIso: () => new Date(current.getTime()).toISOString(),
    set: (iso: string) => {
      current = new Date(iso);
    },
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
    setLocal: (hour: number, minute: number, dayOffset = 0) => {
      const next = new Date(current.getTime());
      next.setDate(next.getDate() + dayOffset);
      next.setHours(hour, minute, 0, 0);
      current = next;
    },
  };
}
