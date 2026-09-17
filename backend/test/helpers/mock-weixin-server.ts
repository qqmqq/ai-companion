import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { QrStatus } from "../../src/channels/weixin/protocol/types.ts";

export interface MockWeixinConfig {
  /** 依次返回的二维码状态；用尽后重复最后一个 */
  qrStatuses?: Array<QrStatus | string>;
  /** 每个状态附带的字段（redirect_host 等） */
  qrExtras?: Record<string, Record<string, unknown>>;
  /** confirmed 时返回的凭证 */
  botToken?: string;
  accountId?: string;
  ilinkUserId?: string;
  /** getupdates 依次返回的 batch：{ msgs, buffer } */
  batches?: Array<{ msgs: Array<Record<string, unknown>>; buffer?: string }>;
  /** 是否校验 Authorization（默认校验） */
  requireAuthorization?: boolean;
  /** sendmessage 前 N 次失败（用于 retry 测试） */
  sendFailures?: number;
  sendFailureStatus?: number;
  /** getupdates 返回的业务错误注入 */
  updatesErrors?: Array<{ ret?: number; errcode?: number; errmsg?: string }>;
  /** 媒体 CDN mock 基址：getuploadurl 会返回指向它的完整上传地址 */
  cdnBaseUrl?: string;
  /** getuploadurl 的响应注入（例如模拟 ret=-14 或缺少上传地址） */
  uploadUrlResponse?: Record<string, unknown>;
  /** 上传地址失效次数（先失败若干次再成功），用于重试测试 */
  uploadUrlFailures?: number;
  /** sendmessage 的固定响应（例如 { ret: 0, errcode: -14 } 用来测凭证失效） */
  sendOverride?: Record<string, unknown>;
}

export interface MockWeixinServer {
  baseUrl: string;
  calls: Array<{ path: string; method: string; authorization: string | null; body: Record<string, unknown> }>;
  sentMessages: Array<{
    to_user_id: string;
    text: string;
    client_id: string;
    context_token: string | null;
    authorization: string | null;
    /** 原始 item_list：图片消息的断言靠它（text 为空是正常的） */
    items: Array<Record<string, unknown>>;
  }>;
  /** 运行时调整行为 */
  config: MockWeixinConfig;
  setBatches(batches: Array<{ msgs: Array<Record<string, unknown>>; buffer?: string }>): void;
  queueBatch(batch: { msgs: Array<Record<string, unknown>>; buffer?: string }): void;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    request.on("end", () => resolve(data));
  });
}

/**
 * 最小可用的微信 iLink Backend mock：
 * 覆盖 QR 登录、getupdates（含错误注入）、sendmessage（含失败注入），
 * 以及鉴权头校验——用于验证"账号之间的凭证不串用"。
 */
export async function startMockWeixinServer(config: MockWeixinConfig = {}): Promise<MockWeixinServer> {
  const state: MockWeixinServer = {
    baseUrl: "",
    calls: [],
    sentMessages: [],
    config: {
      qrStatuses: config.qrStatuses ?? ["wait", "scaned", "confirmed"],
      qrExtras: config.qrExtras ?? {},
      botToken: config.botToken ?? "token-AAA",
      accountId: config.accountId ?? "acct-1",
      ilinkUserId: config.ilinkUserId ?? "self-1",
      batches: config.batches ?? [],
      cdnBaseUrl: config.cdnBaseUrl,
      uploadUrlResponse: config.uploadUrlResponse,
      uploadUrlFailures: config.uploadUrlFailures ?? 0,
      sendOverride: config.sendOverride,
      requireAuthorization: config.requireAuthorization ?? true,
      sendFailures: config.sendFailures ?? 0,
      sendFailureStatus: config.sendFailureStatus ?? 503,
      updatesErrors: config.updatesErrors ?? [],
    },
    setBatches(batches) {
      state.config.batches = batches;
    },
    queueBatch(batch) {
      state.config.batches = [...(state.config.batches ?? []), batch];
    },
    close: async () => {},
  };

  let qrIndex = 0;
  let sendAttempts = 0;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const raw = await readBody(request);
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const authorization = request.headers.authorization ?? null;
      state.calls.push({ path: url.pathname, method: request.method ?? "GET", authorization, body });

      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      const requireAuth = (): boolean => {
        if (state.config.requireAuthorization !== true) return true;
        if (authorization === null || !authorization.startsWith("Bearer ")) {
          send(401, { ret: 401, errmsg: "unauthorized" });
          return false;
        }
        return true;
      };

      if (url.pathname.endsWith("/ilink/bot/get_bot_qrcode")) {
        send(200, { qrcode: "qr-value-1", qrcode_img_content: "weixin://qr/qr-value-1" });
        return;
      }

      if (url.pathname.endsWith("/ilink/bot/get_qrcode_status")) {
        const statuses = state.config.qrStatuses ?? ["wait"];
        const status = statuses[Math.min(qrIndex, statuses.length - 1)] ?? "wait";
        qrIndex += 1;
        const extras = state.config.qrExtras?.[status] ?? {};
        if (status === "confirmed") {
          send(200, {
            status,
            bot_token: state.config.botToken,
            ilink_bot_id: state.config.accountId,
            baseurl: state.baseUrl,
            ilink_user_id: state.config.ilinkUserId,
            ...extras,
          });
          return;
        }
        send(200, { status, ...extras });
        return;
      }

      if (url.pathname.endsWith("/ilink/bot/getupdates")) {
        if (!requireAuth()) return;
        // 运行时注入：允许测试中途改变后端行为
        const injected = (state.config.updatesErrors ?? []).shift();
        if (injected !== undefined) {
          send(200, injected);
          return;
        }
        const batches = [...(state.config.batches ?? [])];
        const batch = batches.shift() ?? { msgs: [], buffer: "" };
        state.config.batches = batches;
        send(200, { ret: 0, msgs: batch.msgs, get_updates_buf: batch.buffer ?? "" });
        return;
      }

      if (url.pathname.endsWith("/ilink/bot/getuploadurl")) {
        if (!requireAuth()) return;
        if ((state.config.uploadUrlFailures ?? 0) > 0) {
          state.config.uploadUrlFailures = (state.config.uploadUrlFailures ?? 0) - 1;
          send(503, { ret: 500, errmsg: "temporarily unavailable" });
          return;
        }
        if (state.config.uploadUrlResponse !== undefined) {
          send(200, state.config.uploadUrlResponse);
          return;
        }
        const base = (state.config.cdnBaseUrl ?? "").replace(/\/+$/, "");
        send(200, {
          ret: 0,
          upload_full_url: `${base}/upload?encrypted_query_param=irrelevant&filekey=irrelevant`,
        });
        return;
      }

      if (url.pathname.endsWith("/ilink/bot/sendmessage")) {
        if (!requireAuth()) return;
        sendAttempts += 1;
        if (sendAttempts <= (state.config.sendFailures ?? 0)) {
          response.writeHead(state.config.sendFailureStatus ?? 503, { "content-type": "application/json" });
          response.end(JSON.stringify({ ret: 500, errmsg: "temporary" }));
          return;
        }
        const msg = (body.msg ?? {}) as Record<string, unknown>;
        const items = Array.isArray(msg.item_list) ? (msg.item_list as Array<Record<string, unknown>>) : [];
        const first = items[0] ?? {};
        const textItem = (first.text_item ?? {}) as Record<string, unknown>;
        state.sentMessages.push({
          to_user_id: String(msg.to_user_id ?? ""),
          text: typeof textItem.text === "string" ? textItem.text : "",
          client_id: String(msg.client_id ?? ""),
          context_token: typeof msg.context_token === "string" ? msg.context_token : null,
          authorization,
          items,
        });
        if (state.config.sendOverride !== undefined) {
          send(200, state.config.sendOverride);
          return;
        }
        send(200, { ret: 0, message_id: `srv-${state.sentMessages.length}` });
        return;
      }

      if (url.pathname.includes("/ilink/bot/msg/notify")) {
        if (!requireAuth()) return;
        send(200, { ret: 0 });
        return;
      }

      send(404, { ret: 404, errmsg: "not found" });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${address.port}`;
  state.close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

/**
 * 构造一条入站语音消息。
 *
 * 线上结构依据 Phase 0 协议研究：`voice_item.media`（与图片/视频同构的 CDN 引用）；
 * 语音没有 `aeskey` 字段，密钥只在 `media.aes_key`；协议也没有记录语音的大小/时长字段，
 * 因此这里不构造它们（不发明字段）。
 */
export function inboundVoiceMessage(input: {
  messageId: string;
  fromUserId: string;
  encryptQueryParam?: string;
  fullUrl?: string;
  mediaAesKey?: string;
  contextToken?: string;
  createTimeMs?: number;
}): Record<string, unknown> {
  return {
    message_id: input.messageId,
    from_user_id: input.fromUserId,
    to_user_id: "bot",
    create_time_ms: input.createTimeMs ?? Date.now(),
    message_type: 1,
    message_state: 2,
    item_list: [
      {
        type: 3,
        voice_item: {
          media: {
            ...(input.encryptQueryParam === undefined ? {} : { encrypt_query_param: input.encryptQueryParam }),
            ...(input.fullUrl === undefined ? {} : { full_url: input.fullUrl }),
            ...(input.mediaAesKey === undefined ? {} : { aes_key: input.mediaAesKey }),
          },
        },
      },
    ],
    ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
  };
}

/**
 * 构造一条入站图片消息。
 * 密钥支持协议里的两种形态：`image_item.aeskey`（hex）与 `media.aes_key`（base64）。
 */
export function inboundImageMessage(input: {
  messageId: string;
  fromUserId: string;
  encryptQueryParam?: string;
  fullUrl?: string;
  aesKeyHex?: string;
  mediaAesKey?: string;
  midSize?: number;
  contextToken?: string;
  createTimeMs?: number;
}): Record<string, unknown> {
  return {
    message_id: input.messageId,
    from_user_id: input.fromUserId,
    to_user_id: "bot",
    create_time_ms: input.createTimeMs ?? Date.now(),
    message_type: 2,
    message_state: 2,
    item_list: [
      {
        type: 2,
        image_item: {
          ...(input.aesKeyHex === undefined ? {} : { aeskey: input.aesKeyHex }),
          ...(input.midSize === undefined ? {} : { mid_size: input.midSize }),
          media: {
            ...(input.encryptQueryParam === undefined ? {} : { encrypt_query_param: input.encryptQueryParam }),
            ...(input.fullUrl === undefined ? {} : { full_url: input.fullUrl }),
            ...(input.mediaAesKey === undefined ? {} : { aes_key: input.mediaAesKey }),
          },
        },
      },
    ],
    ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
  };
}

/**
 * 构造一条入站文件消息。
 *
 * 线上结构依据 Phase 0 协议研究：`file_item.media`（与图片同构）、`file_item.file_name`、
 * `file_item.len`（明文字节数的十进制字符串）；文件没有 `aeskey` 字段，密钥只在 `media.aes_key`。
 */
export function inboundFileMessage(input: {
  messageId: string;
  fromUserId: string;
  fileName?: string;
  /** 明文字节数（十进制字符串或数字） */
  len?: string | number;
  encryptQueryParam?: string;
  fullUrl?: string;
  mediaAesKey?: string;
  contextToken?: string;
  createTimeMs?: number;
}): Record<string, unknown> {
  return {
    message_id: input.messageId,
    from_user_id: input.fromUserId,
    to_user_id: "bot",
    create_time_ms: input.createTimeMs ?? Date.now(),
    message_type: 1,
    message_state: 2,
    item_list: [
      {
        type: 4,
        file_item: {
          ...(input.fileName === undefined ? {} : { file_name: input.fileName }),
          ...(input.len === undefined ? {} : { len: input.len }),
          media: {
            ...(input.encryptQueryParam === undefined ? {} : { encrypt_query_param: input.encryptQueryParam }),
            ...(input.fullUrl === undefined ? {} : { full_url: input.fullUrl }),
            ...(input.mediaAesKey === undefined ? {} : { aes_key: input.mediaAesKey }),
          },
        },
      },
    ],
    ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
  };
}

/**
 * 构造一条入站视频消息。
 *
 * 线上结构依据 Phase 0 协议研究：`video_item.media`（与图片同构）、`video_item.video_size`
 * （**密文**字节数，与图片 `mid_size` 同类）；视频没有 `aeskey` 字段，密钥只在 `media.aes_key`。
 * 协议本身不提供宽高/时长/MIME，因此这里也不构造这些字段。
 */
export function inboundVideoMessage(input: {
  messageId: string;
  fromUserId: string;
  encryptQueryParam?: string;
  fullUrl?: string;
  mediaAesKey?: string;
  /** 密文字节数 */
  videoSize?: number;
  thumbMedia?: Record<string, unknown>;
  contextToken?: string;
  createTimeMs?: number;
}): Record<string, unknown> {
  return {
    message_id: input.messageId,
    from_user_id: input.fromUserId,
    to_user_id: "bot",
    create_time_ms: input.createTimeMs ?? Date.now(),
    message_type: 1,
    message_state: 2,
    item_list: [
      {
        type: 5,
        video_item: {
          ...(input.videoSize === undefined ? {} : { video_size: input.videoSize }),
          ...(input.thumbMedia === undefined ? {} : { thumb_media: input.thumbMedia }),
          media: {
            ...(input.encryptQueryParam === undefined ? {} : { encrypt_query_param: input.encryptQueryParam }),
            ...(input.fullUrl === undefined ? {} : { full_url: input.fullUrl }),
            ...(input.mediaAesKey === undefined ? {} : { aes_key: input.mediaAesKey }),
          },
        },
      },
    ],
    ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
  };
}

/** 构造一条入站文本消息（message_id 用字符串，便于测试 uint64） */
export function inboundTextMessage(input: {
  messageId: string;
  fromUserId: string;
  text: string;
  contextToken?: string;
  createTimeMs?: number;
  itemMsgId?: string;
}): Record<string, unknown> {
  return {
    message_id: input.messageId,
    from_user_id: input.fromUserId,
    to_user_id: "bot",
    create_time_ms: input.createTimeMs ?? Date.now(),
    message_type: 1,
    message_state: 2,
    item_list: [
      {
        type: 1,
        ...(input.itemMsgId === undefined ? {} : { msg_id: input.itemMsgId }),
        text_item: { text: input.text },
      },
    ],
    ...(input.contextToken === undefined ? {} : { context_token: input.contextToken }),
  };
}