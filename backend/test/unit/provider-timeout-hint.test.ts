import assert from "node:assert/strict";
import { test } from "node:test";
import { requestText } from "../../src/providers/http.ts";

/** 模拟"一直不回"：fetch 的 signal 一 abort 就抛 AbortError（与 undici 行为一致） */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal ?? null;
    const fail = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal !== null && signal.aborted) fail();
    signal?.addEventListener("abort", fail);
  });

/** 只关心"失败时那句话"：成功路径在别的用例里覆盖 */
async function failureMessage(
  url: string,
  options: { providerId: string; timeoutMs: number },
): Promise<string> {
  try {
    await requestText(url, { method: "POST" }, { ...options, fetchImpl: hangingFetch });
    throw new Error("本该超时，却成功了： " + url);
  } catch (error) {
    return (error as Error).message;
  }
}

test("超时说人话：本机服务要指明去哪儿看原因，公网服务不要乱指", async () => {
  const local = await failureMessage(
    "http://127.0.0.1:22217/v1/chat/completions",
    { providerId: "ds-free-proxy", timeoutMs: 30 },
  );
  assert.match(local, /请求超时（30ms）/);
  assert.match(local, /本机服务/, "本机超时要提示「可能是它在内部重试」");
  assert.match(local, /看看反代怎么了/, "并指出去哪儿看原因");

  const remote = await failureMessage(
    "https://api.example.com/v1/chat/completions",
    { providerId: "remote", timeoutMs: 30 },
  );
  assert.match(remote, /请求超时（30ms）/);
  assert.equal(remote.includes("本机服务"), false, "公网超时不该提本机反代");
});
