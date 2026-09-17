import type { MemoryCandidate, MemoryScope, MemoryType } from "../model/memory.ts";
import type { ChatMessage } from "../ports/llm-provider.ts";
import { heuristicImportance } from "./scoring.ts";

const SCOPES: MemoryScope[] = ["global", "user", "character", "conversation", "event", "world"];
const TYPES: MemoryType[] = ["fact", "preference", "identity", "event", "promise", "emotion_peak", "summary"];

export const MEMORY_EXTRACTION_SYSTEM_PROMPT = [
  "你是一个记忆抽取器。从给定的一轮对话中抽取值得长期记住的信息。",
  "只输出 JSON 数组，不要输出解释、不要输出 Markdown 代码块。",
  '每项格式：{"scope":"user|character|conversation|event|world","type":"fact|preference|identity|event|promise","content":"用一句中文陈述","importance":0..1,"confidence":0..1,"tags":["..."]}',
  "规则：",
  "1. 只记录明确出现的信息，不要推测、不要编造。",
  "2. 寒暄、情绪波动、无信息量的闲聊不记录（返回空数组 []）。",
  "3. 用户明确要求记住的内容 importance 给 0.9 以上，type 用 identity 或 promise。",
  "4. content 必须自洽可独立阅读：不要使用无指代的代词，直接写角色名或用「用户」指代对方。",
  "5. 最多输出 5 条。",
].join("\n");

export function buildExtractionMessages(input: {
  characterName: string;
  userName: string;
  userText: string;
  assistantText: string;
}): ChatMessage[] {
  return [
    { role: "system", content: MEMORY_EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `角色名：${input.characterName}`,
        `用户称呼：${input.userName}`,
        "对话：",
        `用户：${input.userText}`,
        `${input.characterName}：${input.assistantText}`,
        "请输出 JSON 数组。",
      ].join("\n"),
    },
  ];
}

/** 从模型输出里抠出 JSON 数组（容忍代码块、前后废话）。 */
export function extractJsonArray(raw: string): unknown[] | null {
  const withoutFence = raw.replace(/```(?:json)?/gi, "").trim();
  const start = withoutFence.indexOf("[");
  const end = withoutFence.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ParseResult {
  candidates: MemoryCandidate[];
  rejected: number;
  parseFailed: boolean;
}

/**
 * 校验并归一化抽取结果。抽取（模型）与写库（仓储）在这里彻底解耦：
 * 本函数是纯函数，不碰数据库。
 */
export function parseCandidates(raw: string, occurredAt: string): ParseResult {
  const items = extractJsonArray(raw);
  if (items === null) return { candidates: [], rejected: 0, parseFailed: true };

  const candidates: MemoryCandidate[] = [];
  let rejected = 0;
  for (const item of items) {
    if (item === null || typeof item !== "object") {
      rejected += 1;
      continue;
    }
    const record = item as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const scope = typeof record.scope === "string" ? record.scope.trim() : "";
    const type = typeof record.type === "string" ? record.type.trim() : "";
    if (content.length === 0 || content.length > 400 || !SCOPES.includes(scope as MemoryScope) || !TYPES.includes(type as MemoryType)) {
      rejected += 1;
      continue;
    }
    const importanceRaw = typeof record.importance === "number" ? record.importance : Number.NaN;
    const confidenceRaw = typeof record.confidence === "number" ? record.confidence : Number.NaN;
    const importance = Number.isFinite(importanceRaw)
      ? Math.min(1, Math.max(0, importanceRaw))
      : heuristicImportance(content, type);
    const confidence = Number.isFinite(confidenceRaw) ? Math.min(1, Math.max(0, confidenceRaw)) : 0.6;
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6)
      : [];
    candidates.push({
      scope: scope as MemoryScope,
      type: type as MemoryType,
      content,
      importance,
      confidence,
      tags,
      occurredAt,
    });
  }
  return { candidates: candidates.slice(0, 5), rejected, parseFailed: false };
}

/** 便宜的预筛：明显没有信息量的消息不必调用模型（成本控制第一道闸）。 */
export function looksWorthExtracting(text: string, minChars: number): boolean {
  const trimmed = text.trim();
  if (trimmed.length < minChars) return false;
  const pureChitchat = /^(嗯+|哦+|好的?|哈哈+|在吗|早|晚安|hi|hello|ok|谢谢|草|6)[!！。.~～\s]*$/iu;
  if (pureChitchat.test(trimmed)) return false;
  return true;
}
