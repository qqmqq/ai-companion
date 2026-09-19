import type { ConversationId, MessageId, UserId } from "./ids.ts";
import type { ChannelKind } from "./channel.ts";
import type { MediaKind, MediaReference } from "./media.ts";
import { MEDIA_LIMITS, describeMedia, emptyMediaReference, sanitizeMediaReference } from "./media.ts";
import { describeTranscription, sanitizeTranscription, type TranscriptionState } from "./transcription.ts";
import type { TtsState } from "./tts.ts";

export type MessageRole = "user" | "character" | "system" | "tool";

/** 流式响应的落库状态：绝不把 chunk 当成多条消息。 */
export type MessageStatus = "partial" | "completed" | "failed";

/** 消息来源：主动消息必须在领域模型里与普通对话明确区分（不伪造用户输入）。 */
export type MessageSource = "conversation" | "proactive" | "system";

export type MessageReferenceStatus = "inline" | "resolved" | "unresolved" | "expired";

export interface MessageReference {
  providerMessageId: string;
  text: string | null;
  status: MessageReferenceStatus;
  /** 被引用消息的媒体引用（Phase 4.5-A 起使用通用媒体模型） */
  mediaFileId: string | null;
}

/**
 * 统一富内容片段。
 *
 * 媒体类片段只携带**引用与元数据**（见 media.ts），二进制内容由未来的 MediaStorage 管理。
 * 判别字段沿用项目既有的 `kind`（Phase 1 起全仓库使用），不改成 `type`，避免无意义的大范围重命名。
 */
export interface TextPart {
  kind: "text";
  text: string;
}

export interface QuotePart {
  kind: "quote";
  ref: MessageReference;
}

export interface ImagePart {
  kind: "image";
  media: MediaReference;
  caption?: string;
}

export interface AudioPart {
  kind: "audio";
  media: MediaReference;
  /**
   * 语音转写文本（有则上下文优先使用它）。
   * 这是 ASR 之前的兼容字段；D3 起转写的**状态与元数据**放在 transcription 里。
   */
  transcript?: string;
  /**
   * 转写状态（Phase 4.5-D3）。与 media.status 是两个独立维度：
   * 音频可以 available 而转写 failed —— 转写失败绝不影响音频本身。
   */
  transcription?: TranscriptionState;
  caption?: string;
}

export interface VideoPart {
  kind: "video";
  media: MediaReference;
  caption?: string;
}

export interface FilePart {
  kind: "file";
  media: MediaReference;
  caption?: string;
}

export type MediaMessagePart = ImagePart | AudioPart | VideoPart | FilePart;
export type MessagePart = TextPart | QuotePart | MediaMessagePart;

export function isMediaPart(part: MessagePart): part is MediaMessagePart {
  return part.kind === "image" || part.kind === "audio" || part.kind === "video" || part.kind === "file";
}

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  parts: MessagePart[];
  textRender: string;
  replyToId: MessageId | null;
  providerMessageId: string | null;
  tokenCount: number | null;
  status: MessageStatus;
  errorText: string | null;
  source: MessageSource;
  createdAt: string;
  editedAt: string | null;
  branchOfId: MessageId | null;
  /**
   * 语音合成（TTS）状态（Phase 4.5-D4）。**消息级**：一段语音代表整条回复。
   * 与 message.status / 部件的 media.status / transcription 完全独立 —— 文字永远是权威表示，
   * 语音只是可选附加表示（没有语音不影响文字回复）。
   */
  tts?: TtsState;
}

/** 上下文用的文本表示：媒体只给占位符，绝不把元数据 stringify 进上下文。 */
export function partsToText(parts: MessagePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      chunks.push(part.text);
      continue;
    }
    if (part.kind === "quote") {
      chunks.push(part.ref.text ?? "[引用消息内容未缓存]");
      continue;
    }
    if (part.kind === "audio") {
      // 上下文里的语音表示：有转写就用转写（并注明这是语音），没有就只是占位符。
      // 绝不放音频字节，也不放 [object Object]。
      const transcribed = describeTranscription(part.transcription);
      if (transcribed !== null) {
        chunks.push("[语音] 转写：" + transcribed);
        continue;
      }
      // 兼容字段 transcript 保持历史渲染（就是文本本身）；结构化的 transcription 才带 [语音] 前缀
      if (part.transcript !== undefined && part.transcript.trim().length > 0) {
        chunks.push(part.transcript.trim());
        continue;
      }
      chunks.push(describeMedia("audio", part.media));
      continue;
    }
    chunks.push(describeMedia(part.kind, part.media));
  }
  return chunks.join("\n").trim();
}

export interface PartNormalizationResult {
  parts: MessagePart[];
  /** 被安全降级/丢弃的原因，调用方可记录，但绝不因此丢掉整条消息 */
  rejected: Array<{ index: number; reason: "unknown_kind" | "invalid_shape" | "too_many_parts" | "text_truncated" }>;
}

const MEDIA_KINDS: MediaKind[] = ["image", "audio", "video", "file"];

/**
 * 把任意来源（历史数据库、历史 JSON、渠道映射）的 parts 规范化成当前模型。
 *
 * 兼容策略：
 * - 旧扁平媒体片段（`{kind:"image", fileId, mime, name, size, width, height, durationMs}`）→ 新 MediaReference；
 * - 只有文本的旧消息 → TextPart；
 * - 未知 kind / 结构非法 → **丢弃该片段并记录原因**，其余片段照常保留（安全降级，绝不抛异常）。
 */
export function normalizeMessageParts(raw: unknown): PartNormalizationResult {
  const rejected: PartNormalizationResult["rejected"] = [];
  if (!Array.isArray(raw)) {
    return { parts: [], rejected: raw === null || raw === undefined ? [] : [{ index: -1, reason: "invalid_shape" }] };
  }

  const parts: MessagePart[] = [];
  raw.forEach((entry, index) => {
    if (parts.length >= MEDIA_LIMITS.maxPartsPerMessage) {
      rejected.push({ index, reason: "too_many_parts" });
      return;
    }
    if (entry === null || typeof entry !== "object") {
      rejected.push({ index, reason: "invalid_shape" });
      return;
    }
    const record = entry as Record<string, unknown>;
    const kind = record.kind;

    if (kind === "text") {
      /**
       * 只清掉真正的控制垃圾（NUL/ESC 之类），**换行与制表符必须留下**：
       * 以前这里连 \n 一起删了，于是"从库里读回来的消息"会丢掉所有换行 ——
       * 重投一条回复（渠道重试）或拿 parts 去合成语音时，整段就变成一行。
       */
      const text = typeof record.text === "string" ? record.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "") : "";
      if (text.length === 0) {
        rejected.push({ index, reason: "invalid_shape" });
        return;
      }
      if (text.length > MEDIA_LIMITS.maxTextPartLength) {
        rejected.push({ index, reason: "text_truncated" });
        parts.push({ kind: "text", text: text.slice(0, MEDIA_LIMITS.maxTextPartLength) });
        return;
      }
      parts.push({ kind: "text", text });
      return;
    }

    if (kind === "quote") {
      const ref = record.ref;
      if (ref === null || typeof ref !== "object") {
        rejected.push({ index, reason: "invalid_shape" });
        return;
      }
      const refRecord = ref as Record<string, unknown>;
      const providerMessageId = typeof refRecord.providerMessageId === "string" ? refRecord.providerMessageId : "";
      if (providerMessageId.length === 0) {
        rejected.push({ index, reason: "invalid_shape" });
        return;
      }
      parts.push({
        kind: "quote",
        ref: {
          providerMessageId,
          text: typeof refRecord.text === "string" ? refRecord.text : null,
          status:
            refRecord.status === "inline" || refRecord.status === "resolved" || refRecord.status === "expired"
              ? refRecord.status
              : "unresolved",
          mediaFileId: typeof refRecord.mediaFileId === "string" ? refRecord.mediaFileId : null,
        },
      });
      return;
    }

    if (typeof kind === "string" && MEDIA_KINDS.includes(kind as MediaKind)) {
      const mediaRecord = (record.media ?? {}) as Record<string, unknown>;
      // 旧扁平格式兼容：fileId/mime/name/size 等直接挂在 part 上
      const legacy: Record<string, unknown> = {
        mediaId: record.mediaId ?? record.fileId,
        mimeType: record.mimeType ?? record.mime,
        filename: record.filename ?? record.name,
        sizeBytes: record.sizeBytes ?? record.size,
        width: record.width,
        height: record.height,
        durationMs: record.durationMs,
        origin: record.origin,
        status: record.status,
        url: record.url,
      };
      const merged: Record<string, unknown> = { ...legacy, ...mediaRecord };
      for (const [key, value] of Object.entries(legacy)) {
        if (merged[key] === undefined && value !== undefined) merged[key] = value;
      }
      const media = Object.keys(mediaRecord).length === 0 && Object.values(legacy).every((value) => value === undefined)
        ? emptyMediaReference()
        : sanitizeMediaReference(merged);
      const caption = typeof record.caption === "string" ? record.caption.slice(0, 500) : undefined;
      const transcript = typeof record.transcript === "string" ? record.transcript.slice(0, 5000) : undefined;

      if (kind === "image") parts.push({ kind: "image", media, ...(caption === undefined ? {} : { caption }) });
      else if (kind === "audio") {
        // 转写状态必须走 sanitize：长度截断、控制字符清理、completed 之外不带文本
        const transcription =
          record.transcription === undefined || record.transcription === null
            ? undefined
            : sanitizeTranscription(record.transcription as Record<string, unknown>);
        parts.push({
          kind: "audio",
          media,
          ...(caption === undefined ? {} : { caption }),
          ...(transcript === undefined ? {} : { transcript }),
          ...(transcription === undefined ? {} : { transcription }),
        });
      } else if (kind === "video") parts.push({ kind: "video", media, ...(caption === undefined ? {} : { caption }) });
      else parts.push({ kind: "file", media, ...(caption === undefined ? {} : { caption }) });
      return;
    }

    rejected.push({ index, reason: "unknown_kind" });
  });

  return { parts, rejected };
}

export interface InternalMessage {
  id: MessageId;
  channel: ChannelKind;
  accountId: string;
  conversationId: string;
  sender: { id: string; name: string | null; isSelf: boolean };
  timestamp: string;
  receivedAt: string;
  type: "text" | "image" | "audio" | "video" | "file" | "mixed" | "system";
  parts: MessagePart[];
  replyTo: MessageReference | null;
  metadata: Record<string, unknown>;
  /** 渠道原生标识，只在 Channel Layer 内使用；凭据类字段不得进入 Core。 */
  externalRef: { providerMessageId: string; providerCursor?: string };
}

export type OutboundPart =
  | { kind: "text"; text: string }
  | { kind: "image"; media: MediaReference; caption?: string }
  | { kind: "audio"; media: MediaReference; caption?: string }
  | { kind: "video"; media: MediaReference; caption?: string }
  | { kind: "file"; media: MediaReference; caption?: string }
  | { kind: "typing"; state: "start" | "stop" };

export interface InternalResponse {
  channel: ChannelKind;
  accountId: string;
  conversationId: string;
  parts: OutboundPart[];
  replyToProviderMessageId: string | null;
  streaming: { mode: "none" | "append"; runId: string | null };
  idempotencyKey: string;
}

export function inferMessageType(parts: MessagePart[]): InternalMessage["type"] {
  const kinds = new Set(parts.map((p) => p.kind));
  if (kinds.size === 0) return "system";
  if (kinds.size > 1) return "mixed";
  const only = [...kinds][0];
  if (only === "text" || only === "quote") return "text";
  return only === "image" || only === "audio" || only === "video" || only === "file" ? only : "system";
}

export interface ConversationContextRef {
  userId: UserId;
  conversationId: ConversationId;
}
