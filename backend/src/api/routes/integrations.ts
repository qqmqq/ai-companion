import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Container } from "../../app/bootstrap.ts";
import { parseOrThrow } from "../validation.ts";

/**
 * 接入助手：把"打开真实网页 → 用户登录 → 自动获取所需"做成两条接口。
 *
 * 密码类字段只在这一次请求里用，**不落库、不进日志**；回给界面的只有掩码。
 */
const ApplySchema = z.object({
  email: z.string().min(1).max(200),
  deepseekPassword: z.string().min(1).max(200),
  /** 存过一次之后可以留空：留空就用本机记着的那把 */
  adminPassword: z.string().min(6).max(200).optional(),
  proxyBaseUrl: z.string().max(300).optional(),
});

const StartSchema = z.object({
  proxyBaseUrl: z.string().max(300).optional(),
  /** 用户告诉我们的反代可执行文件路径（找不到时才需要填，填一次就记住） */
  binaryPath: z.string().max(500).optional(),
});

export function registerIntegrationRoutes(app: FastifyInstance, container: Container): void {
  /** 打开真实浏览器并开始自动抓取（幂等：已经在等就返回当前状态） */
  app.post("/api/integrations/ds-free/start", async (request) => {
    const body = parseOrThrow(StartSchema, request.body ?? {});
    return await container.dsFreeLogin.start({
      ...(body.proxyBaseUrl === undefined ? {} : { proxyBaseUrl: body.proxyBaseUrl }),
      ...(body.binaryPath === undefined ? {} : { binaryPath: body.binaryPath }),
    });
  });

  app.get("/api/integrations/ds-free/status", async () => await container.dsFreeLogin.status());

  app.post("/api/integrations/ds-free/stop", async () => {
    container.dsFreeLogin.stop();
    return await container.dsFreeLogin.status();
  });

  /** 一键写入：反代账号池 + API Key + 我们这侧的 provider */
  app.post("/api/integrations/ds-free/apply", async (request) => {
    const body = parseOrThrow(ApplySchema, request.body);
    return await container.dsFreeLogin.apply({
      email: body.email,
      deepseekPassword: body.deepseekPassword,
      ...(body.adminPassword === undefined ? {} : { adminPassword: body.adminPassword }),
      ...(body.proxyBaseUrl === undefined ? {} : { proxyBaseUrl: body.proxyBaseUrl }),
    });
  });
}

