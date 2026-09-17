import type { Logger } from "../../../core/ports/logger.ts";
import type { Clock } from "../../../core/ports/clock.ts";
import type { QQAccountConfig, QQScope } from "../types.ts";

/**
 * 发消息（官方 Bot API v2）：
 *   单聊 POST /v2/users/{openid}/messages
 *   群聊 POST /v2/groups/{group_openid}/messages
 *   headers: Authorization: QQBot <access_token>
 *   body:    { content, msg_type: 0, msg_id?, msg_seq? }
 *
 * msg_id 是"被动回复"的凭据：带上它表示"回复用户刚发的那条"，额度与时效由平台管；
 * 没有 msg_id 就是主动推送（需要平台开通对应权限，失败要把原因原样报出来）。
 */
export interface QQSenderDeps {
  config: () => QQAccountConfig | null;
  accessToken: () => Promise<string>;
  logger: Logger;
  clock: Clock;
  fetchImpl?: typeof fetch;
}

/** 被动回复的序号：同一条 msg_id 下多次回复要递增，否则平台会去重 */
let msgSeq = 0;
function nextMsgSeq(): number {
  msgSeq = (msgSeq + 1) % 65536;
  return msgSeq;
}

export function messagePath(scope: QQScope, targetId: string): string {
  return scope === "c2c" ? "/v2/users/" + targetId + "/messages" : "/v2/groups/" + targetId + "/messages";
}

export function createQQSender(deps: QQSenderDeps) {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    async sendText(input: { scope: QQScope; targetId: string; text: string; msgId?: string | null }): Promise<{ providerMessageId: string | null }> {
      const config = deps.config();
      if (config === null) throw new Error("QQ 渠道还没配置");
      const token = await deps.accessToken();
      const body: Record<string, unknown> = { content: input.text, msg_type: 0 };
      if (typeof input.msgId === "string" && input.msgId.length > 0) {
        body.msg_id = input.msgId;
        body.msg_seq = nextMsgSeq();
      }
      const response = await doFetch(config.baseUrl + messagePath(input.scope, input.targetId), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "QQBot " + token },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error("发 QQ 消息失败（HTTP " + response.status + "）：" + text.slice(0, 200));
      }
      let providerMessageId: string | null = null;
      try {
        const parsed = JSON.parse(text) as { id?: unknown; message_id?: unknown };
        const id = parsed.id ?? parsed.message_id;
        providerMessageId = typeof id === "string" ? id : null;
      } catch {
        providerMessageId = null;
      }
      deps.logger.info("qq message sent", {
        step: "qq.send",
        status: "completed",
        scope: input.scope,
        passive: typeof input.msgId === "string" && input.msgId.length > 0,
        chars: input.text.length,
      });
      return { providerMessageId };
    },
  };
}

export type QQSender = ReturnType<typeof createQQSender>;

