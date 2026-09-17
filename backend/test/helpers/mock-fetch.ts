export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface MockRoute {
  match: (url: string, init: RequestInit) => boolean;
  respond: (init: RequestInit) => Response | Promise<Response>;
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

export function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 按路由匹配的假 fetch；未匹配到一律 404，便于发现"调了不该调的地址"。 */
export function createMockFetch(routes: MockRoute[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | { url: string }, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers as Record<string, string>) ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    for (const route of routes) {
      if (route.match(url, init)) return await route.respond(init);
    }
    return textResponse("no mock route", 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 永不返回的 fetch：用于超时/中止测试。 */
export function createHangingFetch(errorName: "AbortError" | "TimeoutError" | "TypeError" = "AbortError"): typeof fetch {
  return (async (_input: string | URL | { url: string }, init: RequestInit = {}): Promise<Response> => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init.signal ?? null;
      if (signal === null) return;
      const fail = (): void => {
        const error = new Error("aborted");
        error.name = errorName;
        reject(error);
      };
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;
}
