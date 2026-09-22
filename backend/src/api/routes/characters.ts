import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { toCharacterDto } from "../dto/mappers.ts";
import { normalizeDefinition } from "../../core/model/character.ts";
import { parseOrThrow } from "../validation.ts";
import { DomainError } from "../../core/model/errors.ts";
import { MAX_PROMPT_CHARS, characterPromptKey, readCharacterPrompt, readGlobalPrompt } from "../../core/context/custom-prompt.ts";

/** 角色定义：只保留本程序自己会用到的字段（没有任何角色卡格式兼容概念） */
const DefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  systemPrompt: z.string().default(""),
  firstMessage: z.string().default(""),
});

const StatePatchSchema = z.object({
  energy: z.number().min(0).max(1).optional(),
  autonomyLevel: z.enum(["passive", "low", "normal", "high", "autonomous"]).optional(),
  plan: z.array(z.string()).optional(),
  location: z.object({ sceneId: z.string(), label: z.string() }).optional(),
  activity: z
    .object({
      id: z.string(),
      label: z.string(),
      startedAt: z.string(),
      expectedEndAt: z.string().nullable(),
    })
    .optional(),
});

const AvatarSchema = z.object({
  base64: z.string().min(1),
  filename: z.string().min(1).default("avatar.png"),
});

/** 对话提示词：每个角色一份；空串 = 不留覆盖（退回全局默认） */
const PromptSchema = z.object({ prompt: z.string().max(MAX_PROMPT_CHARS) });

/** 头像上限 8 MiB：base64 之后仍在 HTTP 层 12 MiB 请求体上限之内 */
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

/** 只认真正的图片字节（悬空的扩展名/content-type 不算数） */
function detectImageMime(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const StudioHistorySchema = z
  .array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) }))
  .max(20)
  .optional();

/** 角色工坊：只产出候选设定，不落库；用户按确认键才走 create/patch */
const DraftSchema = z.object({
  ideas: z.string().min(1).max(2000),
  history: StudioHistorySchema,
});

const ReviseSchema = z.object({
  definition: DefinitionSchema,
  instruction: z.string().min(1).max(1000),
  history: StudioHistorySchema,
});

/** 角色 DTO + 版本数（列表与详情共用一个出口） */
function withVersionCount(container: Container, id: string) {
  const view = container.services.characters.get(id);
  return toCharacterDto({ ...view, versionCount: container.services.characters.listVersions(id).length });
}

export function registerCharacterRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/characters", async () => {
    return {
      items: container.services.characters
        .list(container.user.id)
        .map((record) => withVersionCount(container, record.id)),
    };
  });

  /** 新建角色：定义直接就是本程序的模型；缺省字段按 normalizeDefinition 补全 */
  app.post("/api/characters", async (request, reply) => {
    const body = parseOrThrow(DefinitionSchema, request.body);
    const view = container.services.characters.create({
      userId: container.user.id,
      definition: normalizeDefinition(body),
      importedFrom: "create",
    });
    reply.code(201);
    return toCharacterDto(view);
  });

  /**
   * 角色工坊第一步：几句设想 → 完整设定（不落库）
   * 注意放在 /api/characters/:id 之前只是习惯，Fastify 静态路径本来就优先于参数路径。
   */
  app.post("/api/characters/draft", async (request) => {
    const body = parseOrThrow(DraftSchema, request.body);
    return container.services.characterStudio.draft(
      { ideas: body.ideas, ...(body.history === undefined ? {} : { history: body.history }) },
      { conversationId: null, messageId: null },
    );
  });

  /** 角色工坊第二步：当前设定 + 一句人话要求 → 改完的完整设定（同样不落库） */
  app.post("/api/characters/revise", async (request) => {
    const body = parseOrThrow(ReviseSchema, request.body);
    const current = normalizeDefinition(body.definition);
    return container.services.characterStudio.revise(
      { definition: current, instruction: body.instruction, ...(body.history === undefined ? {} : { history: body.history }) },
      { conversationId: null, messageId: null },
    );
  });

  app.get("/api/characters/:id", async (request) => {
    const { id } = request.params as { id: string };
    return withVersionCount(container, id);
  });

  /** 编辑 = 新版本：已有会话继续绑定旧版本，新会话用新版本 */
  app.patch("/api/characters/:id", async (request) => {
    const { id } = request.params as { id: string };
    const patch = parseOrThrow(DefinitionSchema.partial(), request.body);
    const current = container.services.characters.get(id);
    const next = normalizeDefinition({ ...current.definition, ...patch });
    container.services.characters.updateDefinition(id, next);
    // 必须重新数版本：直接 toCharacterDto(view) 会漏掉 versionCount，返回一个恒为 1 的假数字
    return withVersionCount(container, id);
  });

  app.delete("/api/characters/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const view = container.services.characters.get(id);
    container.services.characters.remove(id);
    // 头像一起清掉，避免 MediaStorage 里留下没有引用的孤儿文件
    if (view.record.avatarMediaId !== null) await container.mediaStorage.remove(view.record.avatarMediaId);
    reply.code(204);
    return null;
  });

  /** 复制角色（新版本，不影响原角色与会话） */
  app.post("/api/characters/:id/duplicate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const view = container.services.characters.duplicate(id, container.user.id);
    reply.code(201);
    return toCharacterDto(view);
  });

  /** 头像：前端 <img> 直接用，不暴露存储路径 */
  app.get("/api/characters/:id/avatar", async (request, reply) => {
    const { id } = request.params as { id: string };
    const avatarId = container.services.characters.get(id).record.avatarMediaId;
    if (avatarId === null) throw new DomainError("not_found", "这个角色还没有头像");
    const asset = await container.mediaStorage.get(avatarId);
    if (asset === null) throw new DomainError("not_found", "角色头像的文件不存在");
    reply.header("content-type", asset.mimeType ?? "image/png");
    return reply.send(Buffer.from(asset.bytes));
  });

  /** 上传头像：二进制进 MediaStorage，角色记录只保存 mediaId */
  app.put("/api/characters/:id/avatar", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(AvatarSchema, request.body);
    const bytes = Buffer.from(body.base64, "base64");
    if (bytes.length === 0) throw new DomainError("invalid_input", "上传的头像是空文件");
    if (bytes.length > AVATAR_MAX_BYTES) throw new DomainError("invalid_input", "文件过大：头像最大 8 MiB");
    const mimeType = detectImageMime(bytes);
    if (mimeType === null) throw new DomainError("invalid_input", "不是有效的图片（只支持 PNG / JPEG / WebP）");
    const previousId = container.services.characters.get(id).record.avatarMediaId;
    const asset = await container.mediaStorage.put({ bytes, mimeType, filename: body.filename, origin: "external" });
    const view = container.services.characters.setAvatar(id, asset.mediaId);
    if (previousId !== null) await container.mediaStorage.remove(previousId);
    return toCharacterDto(view);
  });

  app.delete("/api/characters/:id/avatar", async (request) => {
    const { id } = request.params as { id: string };
    const previousId = container.services.characters.get(id).record.avatarMediaId;
    container.services.characters.setAvatar(id, null);
    if (previousId !== null) await container.mediaStorage.remove(previousId);
    return toCharacterDto(container.services.characters.get(id));
  });

  /**
   * 对话提示词：每个角色一份，改完下一句就生效。
   * 存在设置表里、不进角色版本 —— 会话冻结在创建时那一版，写进定义里会出现「改了没反应」。
   * 角色没写自己那份时用全局默认，所以 GET 把全局那份也一并给出，界面才说得清留空会发生什么。
   */
  app.get("/api/characters/:id/prompt", async (request) => {
    const { id } = request.params as { id: string };
    container.services.characters.get(id);
    return {
      prompt: readCharacterPrompt(container.repos.settings, id),
      fallback: readGlobalPrompt(container.repos.settings),
    };
  });

  app.put("/api/characters/:id/prompt", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(PromptSchema, request.body);
    container.services.characters.get(id);
    const value = body.prompt.trim();
    // 空串 = 取消覆盖：直接删键，不在设置表里留一条空记录
    if (value.length === 0) container.repos.settings.delete(characterPromptKey(id));
    else container.repos.settings.put(characterPromptKey(id), value, container.clock.nowIso());
    return { prompt: value };
  });

  app.get("/api/characters/:id/versions", async (request) => {
    const { id } = request.params as { id: string };
    return {
      items: container.services.characters.listVersions(id).map((version) => ({
        id: version.id,
        origin: version.importedFrom,
        createdAt: version.createdAt,
      })),
    };
  });

  app.get("/api/characters/:id/state", async (request) => {
    const { id } = request.params as { id: string };
    return container.services.characters.get(id).state;
  });

  app.patch("/api/characters/:id/state", async (request) => {
    const { id } = request.params as { id: string };
    const patch = parseOrThrow(StatePatchSchema, request.body);
    return container.services.characters.updateState(id, patch).state;
  });
}
