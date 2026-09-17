import type { ModelBinding } from "./task-llm.ts";
import type { TaskType } from "../model/task.ts";

/**
 * 任务 → (provider, model) 的唯一决策点。
 * 业务代码不得自行挑选模型；配置来自数据库（model_routes / model_providers）。
 */
export interface ModelRouter {
  resolve(task: TaskType): ModelBinding;
  listRoutes(): ModelBinding[];
}
