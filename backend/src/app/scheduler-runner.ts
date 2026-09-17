import type { Scheduler } from "../core/scheduler/scheduler.ts";
import type { Logger } from "../core/ports/logger.ts";

/**
 * 真实定时器只允许出现在应用层（组合根），Core 的 Scheduler 保持纯 tick 语义，
 * 因此调度逻辑可以用 FakeClock 精确测试，生产环境由这里驱动。
 */
export interface SchedulerRunner {
  start(): void;
  stop(): void;
  /** 测试 / 手动触发一次（真实时钟下的一次 tick） */
  runOnce(): Promise<void>;
  status(): { running: boolean; intervalMs: number; ticks: number; lastTickAt: string | null; lastError: string | null };
}

export function createSchedulerRunner(deps: {
  scheduler: Scheduler;
  runTasks: () => Promise<void>;
  logger: Logger;
  intervalMs?: number;
}): SchedulerRunner {
  const intervalMs = deps.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | null = null;
  let ticks = 0;
  let lastTickAt: string | null = null;
  let lastError: string | null = null;

  async function runOnce(): Promise<void> {
    try {
      const summary = await deps.scheduler.tick();
      await deps.runTasks();
      ticks += 1;
      lastTickAt = summary.at;
      lastError = null;
      if (summary.due > 0) {
        deps.logger.info("scheduler tick", { due: summary.due, ran: summary.ran, skipped: summary.skipped, failed: summary.failed });
      }
    } catch (error) {
      lastError = (error as Error).message;
      deps.logger.error("scheduler tick failed", { error: lastError });
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      // 不阻塞进程退出
      timer.unref?.();
      deps.logger.info("scheduler runner started", { intervalMs });
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    runOnce,
    status: () => ({ running: timer !== null, intervalMs, ticks, lastTickAt, lastError }),
  };
}
