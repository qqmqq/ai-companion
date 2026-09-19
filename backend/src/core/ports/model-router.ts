import type { ModelBinding } from "./task-llm.ts";
import type { TaskType } from "../model/task.ts";

/**
 * 任务 → (provider, model) 的唯一决策点。
 * 业务代码不得自行挑选模型；配置来自数据库（model_routes / model_providers）。
 */
export interface ModelRouter {
  /** 解析不出来就是配置错误：抛错（消息面向用户，说清楚去哪儿配） */
  resolve(task: TaskType): ModelBinding;
  /** 同一个决策，但"现在一个能用的模型都没有"时返回 null —— 给列表/界面用，不该把页面打崩 */
  resolveOrNull(task: TaskType): ModelBinding | null;
  listRoutes(): ModelBinding[];
}
