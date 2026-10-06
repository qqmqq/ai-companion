/**
 * dev-lib.mjs 的类型声明。
 *
 * dev.mjs 是纯 JS（开发期直接 node 跑，不参与构建），但测试要 import 它，
 * 而 backend 的 tsconfig 是 strict —— 没有这份声明，测试文件自己就过不了类型检查。
 */

export declare function shouldRestartForFile(filename: unknown): boolean;

export type FileStat = { mtimeMs: number; size: number };

export declare function createChangeTracker(stat: (filename: string) => FileStat | null): {
  changed(filename: unknown): boolean;
  size(): number;
};

export declare const CHANGE_RESTART_DELAY: number;
export declare const PORT_RETRY_DELAYS: number[];
export declare const PORT_HINT_AFTER_ATTEMPTS: number;

export declare function portRetryDelay(attempt: number): number;
export declare function nextRestartDelay(previousDelay: number, cause: "change" | "crash"): number;
export declare function portBusyHint(port: number): string;
