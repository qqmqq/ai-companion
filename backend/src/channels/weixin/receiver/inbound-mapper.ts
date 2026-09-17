import type { InternalMessage, MediaMessagePart, MessagePart, MessageReference } from "../../../core/model/message.ts";
import { inferMessageType, isMediaPart } from "../../../core/model/message.ts";
import { sanitizeMediaReference, type MediaReference } from "../../../core/model/media.ts";
import { parseDeclaredSize, sanitizeAttachmentFilename } from "../media/file-validation.ts";
import type { WeixinMessage } from "../protocol/types.ts";
import { ITEM_TYPE_TEXT, ITEM_TYPE_VOICE, ITEM_TYPE_IMAGE, ITEM_TYPE_FILE, ITEM_TYPE_VIDEO } from "../protocol/types.ts";
import { toIdString } from "../protocol/lossless-json.ts";

export type InboundSkipReason = "missing_message_id" | "unsupported_content" | "missing_sender" | "self_echo";

/**
 * 入站媒体的**渠道内部**下载描述（Core 永远看不到这些字段）：
 * 加密参数、密钥、发送方声明的密文大小都属于微信协议细节。
 */
export interface InboundMediaCandidate {
  /** 对应 InternalMessage.parts 的下标 */
  partIndex: number;
  kind: "image" | "file" | "video" | "audio";
  encryptQueryParam: string | null;
  fullUrl: string | null;
  /** 协议给出的密钥（hex 或 base64；解码在渠道层完成） */
  aesKey: string | null;
  /** 发送方声明的密文大小（仅用于诊断；图片用 mid_size、视频用 video_size、文件没有） */
  declaredCiphertextSize: number | null;
  /** 发送方声明的**明文**大小（file_item.len；用于下载前的大小闸门） */
  declaredSizeBytes: number | null;
  /** 发送方给出的文件名（已净化；文件才有） */
  filename: string | null;
}

export interface MappedInbound {
  message: InternalMessage;
  /** 会话上下文令牌：只交给渠道层保存，绝不进入 InternalMessage/Core */
  contextToken: string | null;
  providerMessageId: string;
  conversationRef: string;
  /** 需要渠道下载并入库的媒体；Core 只会在下载完成后看到 ImagePart 的引用 */
  mediaCandidates: InboundMediaCandidate[];
}

export interface MapResult {
  mapped: MappedInbound | null;
  skipped: InboundSkipReason | null;
}

function extractText(raw: WeixinMessage): { text: string } {
  const items = raw.item_list ?? [];
  let text = "";
  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT) {
      const value = item.text_item?.text;
      if (typeof value === "string" && value.length > 0 && text.length === 0) text = value;
      continue;
    }
    // 其余类型（图片/文件/视频/语音）由 collectParts 处理；未知类型既不当作文字，也不伪造占位符
  }
  return { text };
}

/** 按媒体种类构造对应部件：联合类型无法从变量收窄，所以这里显式分派（不做类型断言） */
function mediaPart(kind: InboundMediaCandidate["kind"], media: MediaReference): MediaMessagePart {
  if (kind === "image") return { kind: "image", media };
  if (kind === "video") return { kind: "video", media };
  if (kind === "audio") return { kind: "audio", media };
  return { kind: "file", media };
}

/**
 * 构造消息部件：文字 + 图片 + 文件 + 视频 + 语音（可混合）。
 * 媒体只带"引用与状态"：真实的加密参数与密钥留在 mediaCandidates 里，绝不进入 Core。
 *
 * 四种媒体走同一条收集逻辑，差别只在协议字段：
 * - 图片：密钥优先 `image_item.aeskey`（hex），另有 `mid_size`（密文大小）
 * - 文件：密钥只能来自 `media.aes_key`，另有 `file_name` 与 `len`（明文大小，十进制字符串）
 * - 视频：密钥只能来自 `media.aes_key`，另有 `video_size`（密文大小）
 * - 语音：密钥只能来自 `media.aes_key`；协议没有大小/时长字段，因此这两项保持 null
 *
 * 语音/音频只做**传输**：这里不生成 transcript（本阶段没有 ASR），协议也没有该字段。
 */
function collectParts(raw: WeixinMessage, reference: MessageReference | null): {
  parts: MessagePart[];
  candidates: InboundMediaCandidate[];
  hasMedia: boolean;
} {
  const items = raw.item_list ?? [];
  const parts: MessagePart[] = [];
  const candidates: InboundMediaCandidate[] = [];
  let hasMedia = false;

  for (const item of items) {
    if (item.type === ITEM_TYPE_TEXT) {
      const value = item.text_item?.text;
      if (typeof value === "string" && value.length > 0) parts.push({ kind: "text", text: value });
      continue;
    }
    if (
      item.type !== ITEM_TYPE_IMAGE &&
      item.type !== ITEM_TYPE_FILE &&
      item.type !== ITEM_TYPE_VIDEO &&
      item.type !== ITEM_TYPE_VOICE
    ) {
      continue;
    }

    const kind: InboundMediaCandidate["kind"] =
      item.type === ITEM_TYPE_FILE ? "file" : item.type === ITEM_TYPE_VIDEO ? "video" : item.type === ITEM_TYPE_VOICE ? "audio" : "image";
    const media =
      kind === "file"
        ? item.file_item?.media
        : kind === "video"
          ? item.video_item?.media
          : kind === "audio"
            ? item.voice_item?.media
            : item.image_item?.media;
    const encryptQueryParam = media?.encrypt_query_param ?? null;
    const fullUrl = media?.full_url ?? null;
    // 图片：image_item.aeskey（hex）优先于 media.aes_key（base64）；文件/视频/语音只认 media.aes_key
    const aesKey = kind === "image" ? (item.image_item?.aeskey ?? media?.aes_key ?? null) : (media?.aes_key ?? null);
    const declaredSizeBytes = kind === "file" ? parseDeclaredSize(item.file_item?.len) : null;
    const filename = kind === "file" ? sanitizeAttachmentFilename(item.file_item?.file_name) : null;
    // 图片给 mid_size、视频给 video_size，两者都是**密文**字节数；文件没有该字段
    const declaredCiphertextSize =
      kind === "image"
        ? (typeof item.image_item?.mid_size === "number" ? item.image_item.mid_size : null)
        : kind === "video"
          ? (typeof item.video_item?.video_size === "number" ? item.video_item.video_size : null)
          : null;
    const downloadable = (encryptQueryParam !== null || fullUrl !== null) && aesKey !== null;

    const partIndex = parts.length;
    // 三个媒体类型都只带"引用与状态"；协议没有提供的元数据（视频的宽高/时长）保持 null
    parts.push(
      mediaPart(
        kind,
        sanitizeMediaReference({
          origin: "channel",
          filename,
          // 声明大小只是提示，落库后会以真实字节为准
          sizeBytes: declaredSizeBytes,
          // 还没有落库：可下载 → pending；描述不完整 → failed（绝不假装可用）
          status: downloadable ? "pending" : "failed",
        }),
      ),
    );
    hasMedia = true;
    if (downloadable) {
      candidates.push({
        partIndex,
        kind,
        encryptQueryParam,
        fullUrl,
        aesKey,
        declaredCiphertextSize,
        declaredSizeBytes,
        filename,
      });
    }
  }

  if (reference !== null) parts.push({ kind: "quote", ref: reference });
  return { parts, candidates, hasMedia };
}

function extractReference(raw: WeixinMessage): MessageReference | null {
  const items = raw.item_list ?? [];
  for (const item of items) {
    const ref = item.ref_msg;
    if (ref === undefined) continue;
    const providerId = toIdString(ref.svr_id) ?? toIdString(ref.message_item?.msg_id);
    if (providerId === null) continue;
    const inline = ref.message_item?.text_item?.text ?? ref.title ?? null;
    return {
      providerMessageId: providerId,
      text: inline,
      status: inline === null ? "unresolved" : "inline",
      mediaFileId: null,
    };
  }
  return null;
}

/**
 * 线上消息 → InternalMessage。
 *
 * Phase 4 只处理文字：收到纯媒体消息时明确 skip（而不是伪造 [图片] 文本），
 * 媒体映射留到 Phase 4.5。
 */
export function mapWeixinMessage(input: {
  channelKind: string;
  accountId: string;
  raw: WeixinMessage;
  nowIso: string;
  /**
   * **机器人自己**的微信 id（accountId / ilink_bot_id），用于识别机器人自己发出的消息。
   * 不要传 ilink_user_id —— 那是扫码用户本人的 id，传进来会把用户的入站消息全部当成回声丢掉。
   */
  selfUserId?: string | null;
}): MapResult {
  const providerMessageId =
    toIdString(input.raw.message_id) ?? toIdString(input.raw.item_list?.[0]?.msg_id) ?? null;
  if (providerMessageId === null) return { mapped: null, skipped: "missing_message_id" };

  const senderId = toIdString(input.raw.from_user_id);
  if (senderId === null || senderId.length === 0) return { mapped: null, skipped: "missing_sender" };
  if (input.selfUserId !== null && input.selfUserId !== undefined && senderId === input.selfUserId) {
    return { mapped: null, skipped: "self_echo" };
  }

  const { text } = extractText(input.raw);
  const reference = extractReference(input.raw);
  const collected = collectParts(input.raw, reference);

  // 既没有文字也没有可表达的媒体（含未知类型）→ 明确 skip（不伪造占位文本）
  if (text.trim().length === 0 && !collected.hasMedia) {
    return { mapped: null, skipped: "unsupported_content" };
  }
  const parts = collected.parts;

  const createdAt = typeof input.raw.create_time_ms === "number" ? new Date(input.raw.create_time_ms).toISOString() : input.nowIso;

  const message: InternalMessage = {
    id: providerMessageId,
    channel: input.channelKind,
    accountId: input.accountId,
    conversationId: senderId,
    sender: { id: senderId, name: null, isSelf: false },
    timestamp: createdAt,
    receivedAt: input.nowIso,
    type: inferMessageType(parts),
    parts,
    replyTo: reference,
    metadata: {},
    externalRef: { providerMessageId },
  };

  return {
    mapped: {
      message,
      contextToken: typeof input.raw.context_token === "string" && input.raw.context_token.length > 0 ? input.raw.context_token : null,
      providerMessageId,
      conversationRef: senderId,
      mediaCandidates: collected.candidates,
    },
    skipped: null,
  };
}
/**
 * 下载/入库完成后，把渠道内部的媒体引用写回消息部件。
 * 只有"引用与状态"会进入 Core，微信的加密参数与密钥不会出现在这里。
 */
export function applyMediaReferences(parts: MessagePart[], references: Map<number, MediaReference>): MessagePart[] {
  return parts.map((part, index) => {
    const reference = references.get(index);
    if (reference === undefined || !isMediaPart(part)) return part;
    return { ...part, media: reference };
  });
}

/** 媒体处理失败时把对应部件标记为 failed（消息本身照常保留，便于审计）。 */
export function markMediaFailed(parts: MessagePart[], indices: number[]): MessagePart[] {
  const failed = new Set(indices);
  return parts.map((part, index) => {
    if (!isMediaPart(part) || !failed.has(index)) return part;
    // 保留文件名/类型这类安全元数据（便于展示"哪个文件失败了"），只清掉不可用的 mediaId
    return { ...part, media: sanitizeMediaReference({ ...part.media, mediaId: null, status: "failed" }) };
  });
}
