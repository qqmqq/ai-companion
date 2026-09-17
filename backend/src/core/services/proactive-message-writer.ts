import type { Message } from "../model/message.ts";
import type { MessageWriter } from "../ports/message-writer.ts";
import type { ConversationRepository, MessageRepository } from "../ports/repositories.ts";
import type { DomainEventPublisher } from "../ports/events.ts";
import type { Clock } from "../ports/clock.ts";
import { partsToText } from "../model/message.ts";
import { notFound } from "../model/errors.ts";
import { uuidv7 } from "../../util/ids.ts";

/** 主动消息写库：先落占位（partial），再定稿（completed/failed），与流式回复同一纪律。 */
export function createProactiveMessageWriter(deps: {
  messages: MessageRepository;
  conversations: ConversationRepository;
  publisher: DomainEventPublisher;
  clock: Clock;
}): MessageWriter {
  return {
    begin: ({ conversationId, source, text = "" }) => {
      const conversation = deps.conversations.getById(conversationId);
      if (conversation === null) throw notFound("conversation", conversationId);
      const at = deps.clock.nowIso();
      const message: Message = {
        id: uuidv7(),
        conversationId,
        role: "character",
        parts: [{ kind: "text", text }],
        textRender: text,
        replyToId: null,
        providerMessageId: null,
        tokenCount: null,
        status: "partial",
        errorText: null,
        source,
        createdAt: at,
        editedAt: null,
        branchOfId: null,
      };
      deps.messages.insert(message);
      deps.conversations.touchLastMessage(conversationId, at);
      deps.publisher.publish({
        name: "message.new",
        at,
        channel: conversation.channel,
        payload: { conversationId, messageId: message.id, role: "character", source },
      });
      return message;
    },
    finalize: ({ messageId, text, status, errorText = null }) => {
      deps.messages.updateStreaming(messageId, {
        parts: [{ kind: "text", text }],
        textRender: partsToText([{ kind: "text", text }]),
        status,
        errorText,
      });
      const stored = deps.messages.getById(messageId);
      if (stored === null) throw notFound("message", messageId);
      return stored;
    },
  };
}
