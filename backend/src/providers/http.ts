import { ProviderError, isRetryable, kindFromHttpStatus } from "../core/model/provider-error.ts";

export type FetchLike = typeof fetch;

export interface RequestOptions {
  providerId: string;
  model?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export interface HttpResult {
  response: Response;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * 统一的 HTTP 调用：超时、外部中止、网络错误、HTTP 状态全部归一化为 ProviderError。
 * 上层（Core）永远看不到 undici/fetch 的原始错误类型。
 */
export async function requestText(
  url: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<HttpResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signals: AbortSignal[] = [timeoutSignal];
  if (options.signal !== undefined) signals.push(options.signal);
  const signal = signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (isAbort(error)) {
      const abortedByCaller = options.signal?.aborted === true;
      /**
       * 打本机服务（例如自建反代）超时时，多半不是网络慢，而是那个服务自己在内部重试：
       * 这里最有用的就是把「去哪儿看原因」告诉用户。
       */
      const localHint = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(url)
        ? "。这是本机服务：它很可能在内部一直重试（比如反代账号池里没有可用账号）——「模型设置 → 接入助手」里的「看看反代怎么了」会告诉你原因。"
        : "";
      throw new ProviderError(
        abortedByCaller ? "请求已被取消" : `请求超时（${options.timeoutMs}ms）` + localHint,
        {
          providerId: options.providerId,
          kind: abortedByCaller ? "aborted" : "timeout",
          httpStatus: null,
          retryable: !abortedByCaller && isRetryable("timeout"),
          ...(options.model === undefined ? {} : { model: options.model }),
        },
        { cause: error },
      );
    }
    throw new ProviderError(`网络错误: ${(error as Error).message}`, {
      providerId: options.providerId,
      kind: "network",
      httpStatus: null,
      retryable: true,
      ...(options.model === undefined ? {} : { model: options.model }),
    }, { cause: error });
  }

  if (!response.ok) {
    // 只在失败时读取响应体用于诊断；成功时绝不消费 body，否则流式响应会因流被锁死而失败。
    const errorBody = await response.text().catch(() => "");
    const kind = kindFromHttpStatus(response.status);
    throw new ProviderError(
      `上游返回 ${response.status}: ${errorBody.slice(0, 300) || response.statusText}`,
      {
        providerId: options.providerId,
        kind,
        httpStatus: response.status,
        retryable: isRetryable(kind),
        ...(options.model === undefined ? {} : { model: options.model }),
      },
    );
  }
  return { response };
}

export async function requestJson<T>(url: string, init: RequestInit, options: RequestOptions): Promise<T> {
  const { response } = await requestText(url, init, options);
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    throw new ProviderError("读取上游响应失败", {
      providerId: options.providerId,
      kind: "network",
      httpStatus: null,
      retryable: true,
    }, { cause: error });
  }
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    throw new ProviderError("上游返回的不是合法 JSON", {
      providerId: options.providerId,
      kind: "invalid_response",
      httpStatus: null,
      retryable: false,
      ...(options.model === undefined ? {} : { model: options.model }),
    }, { cause: error });
  }
}

/** 把 SSE / NDJSON 流按行切分，跳过空行。 */
export async function* iterateLines(response: Response, options: RequestOptions): AsyncGenerator<string> {
  if (response.body === null) {
    throw new ProviderError("上游响应没有可读流", {
      providerId: options.providerId,
      kind: "invalid_response",
      httpStatus: null,
      retryable: false,
    });
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) yield line;
        index = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}