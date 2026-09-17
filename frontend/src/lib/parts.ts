import type { MessagePartDto } from "./types.ts";

/**
 * 媒体占位符：本阶段只做展示，不做上传/下载/预览。
 * 未知类型安全降级为"未知内容"，绝不把对象直接渲染出来。
 */
export function partPlaceholder(part: MessagePartDto): string | null {
  switch (part.kind) {
    case "text":
      return null;
    case "image":
      return "[图片]";
    case "audio":
      return "[语音]";
    case "video":
      return "[视频]";
    case "file": {
      const media = (part as { media?: { filename?: string | null } }).media;
      const name = media?.filename ?? null;
      return name === null ? "[文件]" : `[文件：${name}]`;
    }
    case "quote":
      return "[引用]";
    default:
      return "[未知内容]";
  }
}

export type AudioTranscriptionView =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "completed"; text: string }
  | { kind: "failed"; reason: string | null };

/**
 * 语音消息的转写展示状态（Phase 4.5-D3）。
 * 只做展示：pending/processing 显示"转写中"，completed 显示文本，failed 显示"转写不可用"。
 */
export function audioTranscription(part: MessagePartDto): AudioTranscriptionView {
  if (part.kind !== "audio") return { kind: "none" };
  const record = part as { transcription?: { status?: string; text?: string | null }; transcript?: string };
  const status = record.transcription?.status;
  if (status === undefined || status === null) {
    return record.transcript !== undefined && record.transcript.length > 0 ? { kind: "completed", text: record.transcript } : { kind: "none" };
  }
  if (status === "completed") {
    const text = record.transcription?.text ?? record.transcript ?? "";
    return text.length > 0 ? { kind: "completed", text } : { kind: "failed", reason: "empty" };
  }
  if (status === "failed") return { kind: "failed", reason: null };
  return { kind: "pending" };
}

/** 一条消息里所有非文本内容的占位符（按出现顺序） */
export function mediaPlaceholders(parts: MessagePartDto[] | undefined): string[] {
  if (parts === undefined) return [];
  const out: string[] = [];
  for (const part of parts) {
    const placeholder = partPlaceholder(part);
    if (placeholder !== null) out.push(placeholder);
  }
  return out;
}
