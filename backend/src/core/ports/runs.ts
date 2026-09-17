/**
 * 运行中的流式任务注册表（端口）。
 * Core 用它来登记/取消一次生成；具体实现（例如放在组合根）不属于 Core。
 */
export interface ActiveRunInfo {
  id: string;
  startedAt: string;
}

export interface RunRegistry {
  register(id: string, controller: AbortController): void;
  abort(id: string): boolean;
  finish(id: string): void;
  list(): ActiveRunInfo[];
}
