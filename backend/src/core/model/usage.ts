import type { TaskType } from "./task.ts";

export interface ModelUsageRecord {
  id: string;
  providerId: string;
  model: string;
  taskType: TaskType;
  conversationId: string | null;
  messageId: string | null;
  inputTokens: number | null; // provider 不返回 usage 时为 NULL，绝不伪造
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  latencyMs: number;
  success: boolean;
  errorKind: string | null;
  createdAt: string;
}

export interface ModelUsageInput {
  providerId: string;
  model: string;
  taskType: TaskType;
  conversationId: string | null;
  messageId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: number | null;
  latencyMs: number;
  success: boolean;
  errorKind: string | null;
}

/** 数据库中的 Provider 配置；密钥永远不在这里（放 CredentialStore）。 */
export type ProviderKind = "openai-compatible" | "ollama" | "echo";

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  displayName: string;
  baseUrl: string;
  defaultModel: string;
  /** 凭据引用（CredentialStore 的 accountId），没有密钥的本地服务为 null */
  credentialRef: string | null;
  /** 是否在请求里附加凭据（本地服务通常不需要） */
  requiresCredential: boolean;
  timeoutMs: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 任务 → (provider, model) 的绑定；可被用户在高级设置里覆盖。 */
export interface ModelRoute {
  taskType: TaskType;
  providerId: string | null;
  model: string | null;
  updatedAt: string;
}
