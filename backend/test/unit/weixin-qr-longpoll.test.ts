import { test } from "node:test";
import assert from "node:assert/strict";
import { createQrLoginService } from "../../src/channels/weixin/auth/qr-login.ts";
import { createLogger } from "../../src/app/logger.ts";
import { createFakeClock } from "../helpers/fake-clock.ts";
import type { WeixinHttp, RequestContext } from "../../src/channels/weixin/protocol/http-client.ts";

/**
 * 回归测试：扫码状态是**长轮询**接口。
 *
 * 真实服务端会保持连接约 30 秒才返回 {ret:0,status:"wait"}；如果我们用默认的 20s 超时，
 * 每一次轮询都会被自己的客户端中止，状态永远是"未知"，二维码永远停在"等待扫描"，
 * 登录也就永远无法完成（线上表现就是"添加微信账号用不了"）。
 */
function stubHttp(seen: Array<{ label: string; timeoutMs: number | undefined }>, status: string) {
  const http = {
    async getJson<T>(_url: string, context: RequestContext): Promise<T> {
      seen.push({ label: context.label, timeoutMs: context.timeoutMs });
      return { ret: 0, status } as unknown as T;
    },
    async postJson<T>(): Promise<T> {
      return { qrcode: "qr-value", qrcode_img_content: "weixin://qr/qr-value", ret: 0 } as unknown as T;
    },
  } as unknown as WeixinHttp;
  return http;
}

test("qr status polling uses a long-poll safe timeout and parses the real status", async () => {
  const seen: Array<{ label: string; timeoutMs: number | undefined }> = [];
  const service = createQrLoginService({
    http: stubHttp(seen, "wait"),
    logger: createLogger({ level: "error", sink: () => {} }),
    clock: createFakeClock(),
  });

  const session = await service.start({});
  assert.equal(session.phase, "waiting_scan");
  assert.equal(session.qrcode, "qr-value");

  const view = await service.step(session.sessionId);
  const poll = seen.at(-1);
  assert.equal(poll?.label, "qrstatus");
  assert.equal(
    view?.rawStatus,
    "wait",
    "状态必须真的被解析出来（超时被中止时这里是 null，登录会永远卡住）",
  );
  assert.ok(
    (poll?.timeoutMs ?? 0) >= 35_000,
    "扫码状态是长轮询：超时必须 >= 35s（服务端约 30s 才回），实际=" + String(poll?.timeoutMs),
  );
});

test("qr status transitions still work with the long-poll timeout in place", async () => {
  const seen: Array<{ label: string; timeoutMs: number | undefined }> = [];
  const service = createQrLoginService({
    http: stubHttp(seen, "scaned"),
    logger: createLogger({ level: "error", sink: () => {} }),
    clock: createFakeClock(),
  });
  const session = await service.start({});
  const view = await service.step(session.sessionId);
  assert.equal(view?.phase, "scanned");
  assert.equal(view?.rawStatus, "scaned");
});
