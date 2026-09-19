import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";

/**
 * 对话提示词补充：使用者自己想加的规则（语气、称呼、禁忌…）。
 * 它会追加进「系统约束」那一段，对所有角色生效；角色自己的 system prompt 仍在角色卡里改。
 */
const PromptSchema = z.object({ custom: z.string().max(4000) });

export function registerPromptRoutes(app: FastifyInstance, container: Container): void {
  app.get("/api/context/prompt", async () => ({
    custom: container.repos.settings.get<string>("prompt.custom", ""),
    // 界面要能说清它落在哪：系统约束之后、角色设定之前
    appliesTo: "系统约束（对所有角色生效）",
  }));

  app.put("/api/context/prompt", async (request) => {
    const body = parseOrThrow(PromptSchema, request.body);
    const value = body.custom.trim();
    container.repos.settings.put("prompt.custom", value, container.clock.nowIso());
    return { custom: value };
  });
}
