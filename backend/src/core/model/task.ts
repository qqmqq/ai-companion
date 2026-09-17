/**
 * 任务类型是"要用哪一档模型"的唯一判据。
 * 业务代码只说我要做什么任务，由 ModelRouter 决定 provider + model。
 */
export type TaskType =
  | "chat"
  | "memory_extraction"
  | "summarization"
  | "context_compression"
  | "emotion_analysis"
  /** 角色工坊：把设想补全成角色设定、按人话改设定 */
  | "character_draft"
  // 预留（后续 Phase 使用，Router 配置已可表达）
  | "reasoning"
  | "agent"
  | "proactive"
  | "translation"
  | "embedding";

export const TASK_TYPES: TaskType[] = [
  "chat",
  "memory_extraction",
  "summarization",
  "context_compression",
  "emotion_analysis",
  "character_draft",
  "reasoning",
  "agent",
  "proactive",
  "translation",
  "embedding",
];

/** 任务的成本/质量档位：Router 的默认配置按档位映射到模型。 */
export type TaskTier = "cheap" | "standard" | "advanced";