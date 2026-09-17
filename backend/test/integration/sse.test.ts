import { test } from "node:test";
import assert from "node:assert/strict";
import { createRunningServer } from "../helpers/container.ts";

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 500)),
    ]);
    if (chunk.done || chunk.value === undefined) continue;
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.includes("\n\n")) return buffer;
  }
  return buffer;
}

test("SSE stream delivers domain events end to end", async () => {
  const server = await createRunningServer();
  const controller = new AbortController();
  try {
    const response = await fetch(`${server.baseUrl}/api/events/stream`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body!.getReader();
    const connected = await readWithTimeout(reader, 3000);
    assert.match(connected, /: connected/);

    const characterResponse = await fetch(`${server.baseUrl}/api/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Aria", description: "温柔的咖啡师", personality: "安静", scenario: "书房", systemPrompt: "", firstMessage: "你好。" }),
    });
    const character = (await characterResponse.json()) as { id: string };

    const conversationResponse = await fetch(`${server.baseUrl}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: character.id }),
    });
    const conversation = (await conversationResponse.json()) as { id: string };

    await fetch(`${server.baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "流式测试" }),
    });

    const event = await readWithTimeout(reader, 5000);
    assert.match(event, /event: (character\.created|conversation\.updated|message\.new|message\.delta)/);
    assert.ok(server.container.webHub.clientCount() >= 1);

    controller.abort();
  } finally {
    await server.close();
  }
});
