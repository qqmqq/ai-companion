import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";
import { toSnapshotDto } from "../dto/mappers.ts";
import { DomainError } from "../../core/model/errors.ts";
import { uuidv7 } from "../../util/ids.ts";
import { nowIso } from "../../util/time.ts";
import type { Message } from "../../core/model/message.ts";
import type { TaskType } from "../../core/model/task.ts";

const PreviewSchema = z.object({ text: z.string().min(1).max(4000), taskType: z.string().default("chat") });

export function registerContextRoutes(app: FastifyInstance, container: Container): void {
  /** Context Preview：构建一次上下文（不调用模型），用于回答"模型这一轮到底看到了什么"。 */
  app.post("/api/conversations/:id/context-preview", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(PreviewSchema, request.body);
    const conversation = container.services.conversations.get(id);

    // 构造一条"未持久化"的临时消息：预览不能污染会话历史
    const transient: Message = {
      id: `preview-${uuidv7()}`,
      conversationId: conversation.id,
      role: "user",
      parts: [{ kind: "text", text: body.text }],
      textRender: body.text,
      replyToId: null,
      providerMessageId: null,
      tokenCount: null,
      status: "completed",
      errorText: null,
      source: "conversation",
      createdAt: nowIso(),
      editedAt: null,
      branchOfId: null,
    };

    const built = await container.services.context.build({
      conversation,
      userId: container.user.id,
      incomingMessage: transient,
      taskType: body.taskType as TaskType,
    });

    return {
      preview: true,
      model: built.model,
      totalTokens: built.bundle.totalTokens,
      budgetTokens: built.bundle.budgetTokens,
      dropped: built.bundle.dropped,
      memoryHits: built.bundle.memoryHits,
      sections: built.bundle.sections.map((section) => ({
        kind: section.kind,
        priority: section.priority,
        title: section.title,
        role: section.role,
        tokenEstimate: section.tokenEstimate,
        truncated: section.truncated,
        sourceIds: section.sourceIds,
        text: section.text,
      })),
    };
  });

  app.get("/api/conversations/:id/snapshots", async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string };
    container.services.conversations.get(id);
    return { items: container.repos.snapshots.listByConversation(id, Math.min(Number(query.limit ?? 20) || 20, 100)).map(toSnapshotDto) };
  });

  app.get("/api/snapshots/:id", async (request) => {
    const { id } = request.params as { id: string };
    const snapshot = container.repos.snapshots.getById(id);
    if (snapshot === null) throw new DomainError("not_found", `snapshot not found: ${id}`);
    return toSnapshotDto(snapshot);
  });

  app.get("/api/runs", async () => {
    return { items: container.runs.list() };
  });

  app.post("/api/runs/:runId/abort", async (request) => {
    const { runId } = request.params as { runId: string };
    const aborted = container.runs.abort(runId);
    return { aborted, runId };
  });
}