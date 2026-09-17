import type { Message, MessageSource } from "../model/message.ts";
import type { ConversationId, MessageId } from "../model/ids.ts";

/** 主动消息自己写入消息行的端口（不伪造用户 inbound）。 */
export interface MessageWriter {
  begin(input: {
    conversationId: ConversationId;
    source: MessageSource;
    text?: string;
  }): Message;
  finalize(input: { messageId: MessageId; text: string; status: Message["status"]; errorText?: string | null }): Message;
}
