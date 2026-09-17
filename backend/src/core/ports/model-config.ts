import type { ModelRoute, ProviderConfig } from "../model/usage.ts";
import type { TaskType } from "../model/task.ts";

/** 模型配置读取端口：Provider 清单与"任务→模型"路由。 */
export interface ModelConfigStore {
  listProviders(): ProviderConfig[];
  getProvider(id: string): ProviderConfig | null;
  getRoute(taskType: TaskType): ModelRoute | null;
  listRoutes(): ModelRoute[];
}
