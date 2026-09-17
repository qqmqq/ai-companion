import type { InternalMessage } from "../../../core/model/message.ts";
import type { QQC2CMessage, QQGroupMessage, QQScope } from "../types.ts";

/**
 * QQ 事件 → Core 的内部消息。
 *
 * 会话引用做成 `c2c:<openid>` / `group:<openid>`：
 * 这样"同一个人的私聊"和"同一个群的群聊"天然是两个会话，出站时也能还原成往哪发。
 */
export function qqConversationRef(scope: QQScope, targetId: string): string {
  return scope + ":" + targetId;
}

export function parseQQConversationRef(ref: string): { scope: QQScope; targetId: string } | null {
  const index = ref.indexOf(":");
  if (index <= 0) return null;
  const scope = ref.slice(0, index);
  const targetId = ref.slice(index + 1);
  if (targetId.length === 0) return null;
  if (scope !== "c2c" && scope !== "group") return null;
  return { scope, targetId };
}

/** 事件里带的 @机器人 前缀要去掉，否则模型会把它当正文 */
export function stripMention(content: string): string {
  return content.replace(/<@!?[0-9A-Za-z_-]+>/g, "").trim();
}

export interface QQInboundContext {
  accountId: string;
  receivedAt: string;
  /** 生成内部消息 id */
  newId: () => string;
}

/** 单聊消息（C2C_MESSAGE_CREATE） */
export function mapQQC2CMessage(payload: QQC2CMessage, context: QQInboundContext): InternalMessage | null {
  const openid = payload?.author?.user_openid;
  if (typeof openid !== "string" || openid.length === 0) return null;
  const text = stripMention(String(payload.content ?? ""));
  return {
    id: context.newId(),
    channel: "qq",
    accountId: context.accountId,
    conversationId: qqConversationRef("c2c", openid),
    sender: { id: openid, name: null, isSelf: false },
    timestamp: context.receivedAt,
    receivedAt: context.receivedAt,
    type: "text",
    parts: [{ kind: "text", text }],
    replyTo: null,
    // msgId 用于"被动回复"配额：QQ 要求带上触发消息的 id
    metadata: { scope: "c2c", userOpenid: openid, msgId: String(payload.id ?? ""), unionOpenid: payload.author?.union_openid ?? null },
    externalRef: { providerMessageId: String(payload.id ?? "") },
  };
}

/** 群聊 @机器人（GROUP_AT_MESSAGE_CREATE） */
export function mapQQGroupMessage(payload: QQGroupMessage, context: QQInboundContext): InternalMessage | null {
  const groupOpenid = payload?.group_openid;
  if (typeof groupOpenid !== "string" || groupOpenid.length === 0) return null;
  const memberOpenid = payload?.author?.member_openid;
  const text = stripMention(String(payload.content ?? ""));
  return {
    id: context.newId(),
    channel: "qq",
    accountId: context.accountId,
    conversationId: qqConversationRef("group", groupOpenid),
    sender: { id: typeof memberOpenid === "string" && memberOpenid.length > 0 ? memberOpenid : groupOpenid, name: null, isSelf: false },
    timestamp: context.receivedAt,
    receivedAt: context.receivedAt,
    type: "text",
    parts: [{ kind: "text", text }],
    replyTo: null,
    metadata: { scope: "group", groupOpenid, memberOpenid: memberOpenid ?? null, msgId: String(payload.id ?? "") },
    externalRef: { providerMessageId: String(payload.id ?? "") },
  };
}

/** 网关事件 → 内部消息；不认识的事件返回 null（上层只记日志，不报错） */
export function mapQQGatewayEvent(event: { t: string; d: unknown }, context: QQInboundContext): InternalMessage | null {
  if (event.t === "C2C_MESSAGE_CREATE") return mapQQC2CMessage(event.d as QQC2CMessage, context);
  if (event.t === "GROUP_AT_MESSAGE_CREATE") return mapQQGroupMessage(event.d as QQGroupMessage, context);
  return null;
}

