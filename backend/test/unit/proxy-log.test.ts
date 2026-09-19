import assert from "node:assert/strict";
import { test } from "node:test";
import { maskDigits, readProxyDiagnosis } from "../../src/integrations/ds-free/proxy-log.ts";

const DATA_DIR = "C:/tmp/companion-test";

function diagnose(log: string | null) {
  return readProxyDiagnosis({
    dataDir: DATA_DIR,
    existsImpl: () => log !== null,
    readImpl: () => log ?? "",
  });
}

test("没有日志时：说清去哪儿找，而不是空口说没问题", () => {
  const result = diagnose(null);
  assert.equal(result.ok, false);
  assert.match(result.summary, /没找到反代日志/);
  assert.deepEqual(result.lines, []);
  assert.match(result.logPath, /ds-free-api[\/\\]run[\/\\]logs[\/\\]runtime\.log$/);
});

test("账号被风控：给出的不是「超时」，而是「被禁言了，等解禁或换账号」", () => {
  const log = [
  "[2026-09-20T04:46:29.554+08:00 ERROR  ds_core::accounts] health_check 检测到业务错误: account=13333332977, response={\"data\":{\"biz_code\":5,\"biz_msg\":\"user is muted\"}}",
  "[2026-09-20T04:46:29.596+08:00 ERROR  ds_core::accounts] Account 13333332977 re-login failed 3 times, marked as Invalid: 账号异常(muted/limited)",
  ].join("\n");
  const result = diagnose(log);
  assert.equal(result.ok, false);
  assert.match(result.summary, /风控|禁言/);
  assert.equal(result.summary.includes("13333332977"), false, "摘要里不该出现账号本身");
  assert.equal(JSON.stringify(result.lines).includes("13333332977"), false, "日志行里的长数字必须打码");
  assert.ok(result.lines.some((line) => line.includes("133****2977")), "打码后仍要能看出是哪个账号：" + JSON.stringify(result.lines));
});

test("账号池空：说清「它只能空转重试，所以我们看到的是超时」", () => {
  const result = diagnose("[2026-09-20T05:15:40.570+08:00 WARN   ds_core::accounts] req=req-15 账号池无可用账号");
  assert.equal(result.ok, false);
  assert.match(result.summary, /没有可用账号/);
  assert.match(result.summary, /超时/);
});

test("密码错 / 上游过载也各自有说法", () => {
  assert.match(diagnose("ERROR adapter 同步添加账号 x 失败: PASSWORD_OR_USER_NAME_IS_WRONG").summary, /账号或密码不对/);
  assert.match(diagnose("WARN adapter service overloaded").summary, /过载/);
});

test("只回最近几条警告，且没有问题时如实说没有", () => {
  const noisy = Array.from({ length: 20 }, (_v, index) => "[t WARN   x] warn-" + String(index)).join("\n");
  const result = diagnose(noisy);
  assert.equal(result.lines.length, 8, "最多 8 条");
  assert.equal(result.lines.at(-1), "[t WARN   x] warn-19", "取的是最近几条");

  const clean = diagnose("[t INFO   http::server] openai兼容base_url: http://127.0.0.1:22217");
  assert.equal(clean.ok, true);
  assert.match(clean.summary, /没有明显报错/);
});

test("打码只动长数字串，不影响正常文本", () => {
  assert.equal(maskDigits("account=13333332977 ok"), "account=133****2977 ok");
  assert.equal(maskDigits("req-15 code=5"), "req-15 code=5", "短数字（请求号、状态码）保持原样");
  assert.equal(maskDigits("时间 2026-09-20"), "时间 2026-09-20");
});
