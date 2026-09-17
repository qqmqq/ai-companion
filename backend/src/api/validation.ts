import type { z } from "zod";
import { DomainError } from "../core/model/errors.ts";

/**
 * zod 的英文提示对用户没有意义。
 * 真实事故：界面上只显示一句「请求参数不合法」，用户不知道是哪个字段、为什么被拒 —— 等于没说。
 * 这里把常见的几条翻成人话，翻不了的也带上字段名原样说明，绝不吞掉"哪里错了"。
 */
export function describeIssue(issue: z.ZodIssue): string {
  const field = issue.path.length === 0 ? "参数" : issue.path.join(".");
  const message = issue.message;
  const atLeast = /at least (\d+) character/.exec(message);
  if (atLeast !== null) return field + " 不能为空";
  const atMost = /at most (\d+) character/.exec(message);
  if (atMost !== null) return field + " 最多 " + atMost[1] + " 个字";
  if (message === "Required") return field + " 是必填的";
  if (message.startsWith("Invalid enum value")) return field + " 的取值不在允许范围内";
  if (message.startsWith("Expected number") || message.startsWith("Expected string")) return field + " 类型不对";
  if (message.startsWith("Invalid input")) return field + " 取值不合法";
  return field + " 不合法（" + message + "）";
}

/** 统一的请求校验：失败一律转成 400 + 结构化 issue 列表（附中文说明）。 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: describeIssue(issue),
    }));
    throw new DomainError("invalid_input", "请求参数不合法：" + issues.map((issue) => issue.message).join("；"), {
      details: { issues },
    });
  }
  return parsed.data as z.output<S>;
}
