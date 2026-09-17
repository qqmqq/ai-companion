import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { toConversationDto, toMessageDto } from "../dto/mappers.ts";
import { parseOrThrow } from "../validation.ts";
import { DomainError } from "../../core/model/errors.ts";
import { WEB_CHANNEL_KIND } from "../../channels/web/channel.ts";
import type { InternalMessage } from "../../core/model/message.ts";
import { uuidv7 } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";

const CreateSchema = z.object({
  characterId: z.string().min(1),
  channel: z.literal("web").default("web"),
  title: z.string().default(""),
  /**
   * 默认是"每个角色一个网页会话"（同一个人重进就回到原来的会话）。
   * newSession=true 表示用户明确要开一个新会话：新会话绑定**当前**角色版本，
   * 已存在的旧会话继续用它们各自冻结的版本。
   */
  newSession: z.boolean().default(false),
});

const PostMessageSchema = z.object({
  text: z.string().min(1).max(8000),
  /** stream=true 时立即返回 runId，增量经 SSE 流出 */
  stream: z.boolean().default(false),
});

/** 把 HTTP 输入转成渠道无关的内部消息；路由不直接调用 Core 服务。 */
function toInternalMessage(container: Container, conversationId: string, text: string, characterId: string): InternalMessage {
  const at = nowIso();
  return {
    id: uuidv7(),
    channel: WEB_CHANNEL_KIND,
    accountId: container.webAccountId,
    conversationId,
    sender: { id: container.user.id, name: container.user.displayName, isSelf: true },
    timestamp: at,
    receivedAt: at,
    type: "text",
    parts: [{ kind: "text", text }],
    replyTo: null,
    metadata: { characterId },
    externalRef: { providerMessageId: `web-${uuidv7()}` },
  };
}

export function registerConversationRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/conversations", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Number(query.limit ?? 50) || 50, 200);
    return {
      items: container.services.conversations.list(container.user.id, limit).map((conversation) =>
        toConversationDto(conversation, {
          lastMessageText: container.repos.messages.lastMessageText(conversation.id),
          // 渠道聊天"现在在跟谁聊"：后台界面直接显示它，并据此做切换按钮的高亮
          activeCharacterId: container.services.characterSwitch.readActive(
            conversation.channel,
            conversation.accountId ?? "",
            conversation.conversationId,
          ),
        }),
      ),
    };
  });

  app.post("/api/conversations", async (request, reply) => {
    const body = parseOrThrow(CreateSchema, request.body);
    container.services.characters.get(body.characterId);
    const conversation = container.services.conversations.ensureConversation({
      userId: container.user.id,
      characterId: body.characterId,
      channel: WEB_CHANNEL_KIND,
      accountId: container.webAccountId,
      conversationRef: body.newSession ? `web:${body.characterId}:${uuidv7().slice(0, 8)}` : `web:${body.characterId}`,
      title: body.title.length > 0 ? body.title : body.newSession ? "新会话" : "",
    });
    reply.code(201);
    return toConversationDto(conversation);
  });

  /**
   * 后台界面里换角色：与微信里的「切换角色 X」完全同一条逻辑 ——
   * 没聊过的角色会开新会话（会话创建时写入的开场白由前端决定要不要发到渠道）。
   */
  app.put("/api/conversations/:id/active-character", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(z.object({ characterId: z.string().min(1), sendOpening: z.boolean().default(true) }), request.body);
    const conversation = container.services.conversations.get(id);
    const outcome = container.services.characterSwitch.switchTo({
      userId: container.user.id,
      channel: conversation.channel,
      accountId: conversation.accountId ?? "",
      conversationRef: conversation.conversationId,
      characterId: body.characterId,
    });
    const switched = container.services.conversations.get(id);
    const target =
      outcome.newConversation
        ? container.services.conversations
            .list(container.user.id, 500)
            .find(
              (entry) =>
                entry.channel === conversation.channel &&
                entry.conversationId === conversation.conversationId &&
                entry.characterId === body.characterId,
            ) ?? switched
        : switched;
    container.repos.audit.append({
      actor: "user",
      action: "conversation.character_switched",
      targetType: "conversation",
      targetId: target.id,
      detail: { channel: conversation.channel, characterId: body.characterId, newConversation: outcome.newConversation },
    });
    /**
     * 开场白要不要真的发到渠道：后台点按钮时默认发（与微信里换人是同一个体感），
     * 但发失败（例如微信没登录）不能把"已经切换成功"这个事实吞掉。
     */
    let delivered = false;
    let deliveryError: string | null = null;
    // web 会话的开场白本来就以消息形式存在库里、由前端直接渲染，这里再发一次会变成重影
    if (body.sendOpening && conversation.channel !== WEB_CHANNEL_KIND && outcome.newConversation && outcome.text.length > 0) {
      const adapter = container.channels.get(conversation.channel);
      if (adapter !== undefined) {
        try {
          const receipt = await adapter.send({
            channel: conversation.channel,
            accountId: conversation.accountId ?? "",
            conversationId: conversation.conversationId,
            parts: [{ kind: "text", text: outcome.text }],
            replyToProviderMessageId: null,
            streaming: { mode: "none", runId: null },
            idempotencyKey: "switch-ui:" + target.id,
          });
          delivered = receipt.providerMessageId !== null || receipt.acceptedAt.length > 0;
        } catch (error) {
          deliveryError = (error as Error).message;
          container.logger.warn("switched character but could not deliver the opening line", {
            step: "chat.character.switch",
            status: "failed",
            errorCategory: "send_failed",
            channel: conversation.channel,
            error: deliveryError,
          });
        }
      }
    }
    return {
      conversationId: target.id,
      characterId: outcome.characterId,
      characterName: container.services.characters.get(body.characterId).definition.name,
      newConversation: outcome.newConversation,
      text: outcome.text,
      delivered,
      deliveryError,
    };
  });

  app.get("/api/conversations/:id", async (request) => {
    const { id } = request.params as { id: string };
    return toConversationDto(container.services.conversations.get(id));
  });

  app.get("/api/conversations/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string; before?: string };
    const limit = Math.min(Number(query.limit ?? 100) || 100, 500);
    const options = query.before === undefined ? { limit } : { limit, before: query.before };
    return { items: container.services.conversations.messages(id, options).map(toMessageDto) };
  });

  app.post("/api/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(PostMessageSchema, request.body);
    const conversation = container.services.conversations.get(id);
    const inbound = toInternalMessage(container, conversation.conversationId, body.text, conversation.characterId);

    if (body.stream) {
      const started = await container.web.deliverInboundStreaming(inbound);
      reply.code(202);
      return started ?? { error: "no character bound" };
    }

    await container.web.deliverInbound(inbound);
    const messages = container.services.conversations.messages(id, { limit: 4 });
    reply.code(201);
    return { items: messages.map(toMessageDto) };
  });

  /**
   * 删除会话。只删这一个会话：
   * - 消息 / 上下文快照 / 摘要随外键级联删除；
   * - 属于该会话的记忆（scope=conversation）删除，其余记忆只解除会话引用（长期记忆保留）；
   * - 角色、角色版本、渠道账号、游标、凭据一律不动 → **删除微信会话不会导致微信掉线**。
   * 重复删除返回 404（明确的 not_found），不会是 500。
   */
  app.delete("/api/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = container.services.conversations.get(id);
    if (conversation.userId !== container.user.id) {
      throw new DomainError("not_found", "conversation not found: " + id, { details: { what: "conversation", id } });
    }
    const memory = container.repos.memories.forgetConversation(id);
    container.services.conversations.remove(id);
    container.repos.audit.append({
      actor: "user",
      action: "conversation.deleted",
      targetType: "conversation",
      targetId: id,
      detail: { channel: conversation.channel, deletedMemories: memory.deletedMemories, detachedMemories: memory.detachedMemories },
    });
    reply.code(204);
    return null;
  });

  app.post("/api/conversations/:id/archive", async (request) => {
    const { id } = request.params as { id: string };
    return toConversationDto(container.services.conversations.setStatus(id, "archived"));
  });

  app.get("/api/conversations/:id/summaries", async (request) => {
    const { id } = request.params as { id: string };
    return { items: container.services.conversations.summaries(id) };
  });

  app.post("/api/conversations/:id/summarize", async (request) => {
    const { id } = request.params as { id: string };
    const summary = await container.services.summaries.summarize(id);
    return { summary };
  });
}
