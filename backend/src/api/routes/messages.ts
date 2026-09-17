import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { toMessageDto } from "../dto/mappers.ts";
import { DomainError } from "../../core/model/errors.ts";
import type { AudioPart, MessagePart } from "../../core/model/message.ts";
import { transcriptionMessageRef } from "../../core/services/transcription-service.ts";

const EditSchema = z.object({ text: z.string().min(1).max(8000) });

export function registerMessageRoutes(app: FastifyInstance, container: Container): void {
  app.patch("/api/messages/:id", async (request) => {
    const { id } = request.params as { id: string };
    const parsed = EditSchema.safeParse(request.body);
    if (!parsed.success) throw new DomainError("invalid_input", "text 必填");
    return toMessageDto(container.services.conversations.editMessage(id, [{ kind: "text", text: parsed.data.text }]));
  });

  app.post("/api/messages/:id/regenerate", async (request) => {
    const { id } = request.params as { id: string };
    return toMessageDto(await container.services.conversations.regenerate(id, container.user.id));
  });

  /**
   * 显式（重新）转写某条消息里的语音部件（Phase 4.5-D3）。
   *
   * 平时转写是入站时自动完成的，而且**同一音频不会被重复识别**（幂等指纹）。
   * 这个入口只在用户/前端明确要求重试时使用：force=true 会忽略已有结果。
   * 转写失败不会影响音频本身，接口返回的是消息的最新状态。
   */
  app.post("/api/messages/:id/transcribe", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { force?: unknown };
    const stored = container.repos.messages.getById(id);
    if (stored === null) throw new DomainError("not_found", "消息不存在");

    // 必须与入站时的身份一致，否则"已完成的转写"不会被复用，会再花一次识别成本
    const messageRef = transcriptionMessageRef({ providerMessageId: stored.providerMessageId, messageId: stored.id });
    const parts: MessagePart[] = [];
    for (const [index, part] of stored.parts.entries()) {
      if (part.kind !== "audio") {
        parts.push(part);
        continue;
      }
      const state = await container.transcription.transcribeStoredPart({
        part: part as AudioPart,
        partIndex: index,
        messageRef,
        force: body.force === true,
      });
      parts.push({ ...part, transcription: state });
    }
    const updated = container.services.conversations.editMessage(id, parts);
    return { message: toMessageDto(updated), transcriptions: container.repos.transcriptions.listByMessage(messageRef) };
  });

  /**
   * 显式生成/重新生成一条消息的语音（Phase 4.5-D4）。
   *
   * 平时语音是回复送达后自动生成的（而且同一段文本不会被重复合成 —— 指纹缓存）。
   * 这个入口用于前端主动请求：返回最新消息（含 message.tts 状态与音频部件）。
   * 注意：它**只生成不投递**，避免与自动投递重复发送。
   */
  app.post("/api/messages/:id/speech", async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { force?: unknown };
    const message = container.services.conversations.getMessage(id);
    const text = message.textRender.trim();
    const result = await container.tts.synthesizeForText(text, { force: body.force === true, messageRef: id });

    let updated = container.services.conversations.setSpeechState(id, result.state);
    if (result.state.status === "completed" && result.state.mediaId !== null) {
      updated = container.services.conversations.attachGeneratedSpeech(id, {
        kind: "audio",
        media: {
          mediaId: result.state.mediaId,
          mimeType: result.state.mimeType,
          filename: null,
          sizeBytes: null,
          width: null,
          height: null,
          durationMs: result.state.durationMs,
          origin: "generated",
          status: "available",
          url: { kind: "internal", value: "media:" + result.state.mediaId },
        },
      }, result.state);
    }
    return { message: toMessageDto(updated), providerCalled: result.providerCalled, syntheses: container.repos.ttsSyntheses.listForMessage(id) };
  });

  app.delete("/api/messages/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    container.services.conversations.deleteMessage(id);
    reply.code(204);
    return null;
  });
}
