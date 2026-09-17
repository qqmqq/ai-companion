import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { describeIssue, parseOrThrow } from "../../src/api/validation.ts";

test("校验失败要说清是哪个字段、为什么，而不是一句「请求参数不合法」了事", () => {
  const schema = z.object({ ideas: z.string().min(1).max(2000) });
  try {
    parseOrThrow(schema, { ideas: "" });
    assert.fail("空字符串必须被拒");
  } catch (error) {
    const domain = error as Error & { code?: string; details?: { issues: Array<{ path: string; message: string }> } };
    assert.equal(domain.code, "invalid_input");
    assert.match(domain.message, /ideas 不能为空/);
    assert.deepEqual(domain.details?.issues, [{ path: "ideas", message: "ideas 不能为空" }]);
  }

  try {
    parseOrThrow(schema, { ideas: "想".repeat(2001) });
    assert.fail("超长必须被拒");
  } catch (error) {
    assert.match((error as Error).message, /ideas 最多 2000 个字/);
  }
});

test("其它常见校验也能翻成人话", () => {
  const at = (issue: z.ZodIssue): string => describeIssue(issue);
  const from = (schema: z.ZodTypeAny, input: unknown): string => {
    const parsed = schema.safeParse(input);
    assert.equal(parsed.success, false);
    return at((parsed as { error: z.ZodError }).error.issues[0] as z.ZodIssue);
  };
  assert.match(from(z.string(), 123), /类型不对/);
  assert.match(from(z.object({ kind: z.enum(["a", "b"]) }), { kind: "c" }), /取值不在允许范围内/);
  assert.match(from(z.object({ title: z.string().min(1) }), {}), /title 不能为空|title 类型不对|title 是必填的/);
  assert.match(from(z.array(z.string()).min(1, "至少一条"), []), /至少一条|不合法/);
});

test("合法输入原样通过，不额外加工", () => {
  const schema = z.object({ ideas: z.string().min(1), count: z.number().default(1) });
  assert.deepEqual(parseOrThrow(schema, { ideas: "一个开旧书店的人" }), { ideas: "一个开旧书店的人", count: 1 });
});
