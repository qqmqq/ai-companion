import type { InternalMessage, MessagePart, AudioPart } from "../model/message.ts";
import type { AsrProvider, AsrProviderRegistry } from "../ports/asr.ts";
import type { TranscriptionRepository, TranscriptionRecord } from "../ports/repositories.phase45.ts";
import type { MediaStorage } from "../ports/media-storage.ts";
import type { SettingsRepository } from "../ports/repositories.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import { ProviderError, type ProviderErrorKind } from "../model/provider-error.ts";
import { sanitizeTranscription, type TranscriptionState } from "../model/transcription.ts";
import { createKeyedLock, type KeyedLock } from "../../util/keyed-lock.ts";

/**
 * 语音转写服务（Phase 4.5-D3）。
 *
 * 职责边界：
 * - 只做"音频 → 文本"这一件事；不生成语音（TTS）、不克隆音色、不做说话人识别；
 * - 音频字节从 MediaStorage 取（**绝不**放进消息/数据库/日志）；
 * - 结果写进 TranscriptionRepository（文本 + 元数据），并作为 AudioPart.transcription 回到消息里；
 * - 失败**不会**影响音频可用性，也不会把失败伪装成空文本。
 *
 * 隐私：日志里只有 mediaId、大小、MIME、时长、provider、模型、错误分类，
 * **没有**音频字节，也**没有**完整转写原文（只记录长度）。
 */

export interface AsrSettings {
  enabled: boolean;
  providerId: string | null;
  model: string | null;
  language: string | null;
  timeoutMs: number;
  maxDurationMs: number;
  maxBytes: number;
  /** 语言/模型/超时等改变后指纹会变，从而允许重新识别（策略见报告） */
  configVersion: string;
}

export const DEFAULT_ASR_SETTINGS: AsrSettings = {
  enabled: false,
  providerId: null,
  model: null,
  language: null,
  timeoutMs: 20_000,
  maxDurationMs: 300_000,
  maxBytes: 25 * 1024 * 1024,
  configVersion: "v1",
};

export function readAsrSettings(settings: SettingsRepository): AsrSettings {
  return {
    enabled: settings.get<boolean>("asr.enabled", DEFAULT_ASR_SETTINGS.enabled),
    providerId: settings.get<string | null>("asr.providerId", DEFAULT_ASR_SETTINGS.providerId),
    model: settings.get<string | null>("asr.model", DEFAULT_ASR_SETTINGS.model),
    language: settings.get<string | null>("asr.language", DEFAULT_ASR_SETTINGS.language),
    timeoutMs: settings.get<number>("asr.timeoutMs", DEFAULT_ASR_SETTINGS.timeoutMs),
    maxDurationMs: settings.get<number>("asr.maxDurationMs", DEFAULT_ASR_SETTINGS.maxDurationMs),
    maxBytes: settings.get<number>("asr.maxBytes", DEFAULT_ASR_SETTINGS.maxBytes),
    configVersion: settings.get<string>("asr.configVersion", DEFAULT_ASR_SETTINGS.configVersion),
  };
}

export interface TranscriptionServiceDeps {
  registry: AsrProviderRegistry & { rebuild?(configs: never[], modelOverride?: string | null): Promise<void> };
  repository: TranscriptionRepository;
  storage: MediaStorage;
  settings: SettingsRepository;
  logger: Logger;
  clock: Clock;
  /** 测试可注入；默认是进程内按指纹串行化的互斥锁（防止并发重复调用 provider） */
  lock?: KeyedLock;
}

export interface TranscribeOptions {
  signal?: AbortSignal;
  /** 显式重新识别：忽略已完成的缓存（仅在用户/系统明确要求时使用） */
  force?: boolean;
}

export interface TranscribeResult {
  state: TranscriptionState;
  /** 是否真的调用了 provider（false = 复用了已有结果或未满足前置条件） */
  providerCalled: boolean;
}

/** 错误分类 → 结构化 errorCode（与 ProviderError 的分类体系一致） */
function classifyError(error: unknown): { code: string; message: string } {
  if (error instanceof ProviderError) {
    const kind: ProviderErrorKind = error.providerKind;
    return { code: kind, message: error.message };
  }
  if (error instanceof Error && error.name === "AbortError") return { code: "aborted", message: "转写被取消" };
  return { code: "unknown", message: error instanceof Error ? error.message : String(error) };
}

/**
 * 转写记录的"消息身份"：优先用渠道消息 id（入站与后续显式重试才能命中同一条记录），
 * 没有渠道 id 时退回落库消息 id。两条路径必须用同一套身份，否则幂等会失效。
 */
export function transcriptionMessageRef(input: { providerMessageId?: string | null; messageId?: string | null }): string {
  const provider = input.providerMessageId ?? null;
  if (provider !== null && provider.length > 0) return provider;
  return input.messageId ?? "";
}

export function createTranscriptionService(deps: TranscriptionServiceDeps) {
  const lock = deps.lock ?? createKeyedLock();
  function fingerprintOf(input: { mediaId: string; audioSize: number; providerId: string; model: string | null; language: string | null; settings: AsrSettings }): string {
    // 确定性指纹：同一份音频 + 同一套 provider/model/语言/配置版本 → 同一指纹
    return [
      input.settings.configVersion,
      input.providerId,
      input.model ?? "-",
      input.language ?? "-",
      input.mediaId,
      String(input.audioSize),
    ].join("|");
  }

  function resolveProvider(settings: AsrSettings): AsrProvider | null {
    if (!settings.enabled) return null;
    const id = settings.providerId;
    if (id === null || id.length === 0) return null;
    return deps.registry.get(id) ?? null;
  }

  /**
   * 处理一条入站消息里的所有音频部件：就地补充 transcription 状态。
   * 返回新的 parts（不改原数组），保证"音频部件本身原样保留"。
   */
  async function transcribeInboundMessage(message: InternalMessage, options: TranscribeOptions = {}): Promise<{ parts: MessagePart[]; states: Map<number, TranscriptionState> }> {
    const settings = readAsrSettings(deps.settings);
    const states = new Map<number, TranscriptionState>();
    const provider = resolveProvider(settings);

    const parts: MessagePart[] = [];
    for (const [index, part] of message.parts.entries()) {
      if (part.kind !== "audio") {
        parts.push(part);
        continue;
      }
      const state = await transcribePart({
        part,
        partIndex: index,
        messageRef: transcriptionMessageRef({ providerMessageId: message.externalRef.providerMessageId, messageId: message.id }),
        settings,
        provider,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.force === undefined ? {} : { force: options.force }),
      });
      states.set(index, state);
      parts.push({ ...part, transcription: state });
    }
    return { parts, states };
  }

  /**
   * 单个部件的转写。
   * Phase 4.5-E：整段流程按"消息 + 部件 + 指纹"串行化 ——
   * 否则两个并发请求会同时错过缓存，重复调用 provider（重复付费）。
   * 串行化之后，后到的那一个必然看到前一个写下的 completed 结果（除非 force）。
   */
  async function transcribePart(input: {
    part: AudioPart;
    partIndex: number;
    messageRef: string;
    settings: AsrSettings;
    provider: AsrProvider | null;
    signal?: AbortSignal;
    force?: boolean;
  }): Promise<TranscriptionState> {
    const { part, partIndex, messageRef } = input;
    const lockKey =
      messageRef + ":" + String(partIndex) + ":" + (part.media.mediaId ?? "-") + ":" + (input.force === true ? "force" : "normal");
    return lock.runExclusive(lockKey, () => transcribePartUnlocked(input));
  }

  async function transcribePartUnlocked(input: {
    part: AudioPart;
    partIndex: number;
    messageRef: string;
    settings: AsrSettings;
    provider: AsrProvider | null;
    signal?: AbortSignal;
    force?: boolean;
  }): Promise<TranscriptionState> {
    const { part, partIndex, messageRef, settings, provider } = input;
    const now = deps.clock.nowIso();
    const mediaId = part.media.mediaId;
    // 指纹必须在使用前确定（writeState 会用到它）
    const fingerprint = fingerprintOf({
      mediaId: mediaId ?? "-",
      audioSize: part.media.sizeBytes ?? 0,
      providerId: provider?.id ?? settings.providerId ?? "-",
      model: settings.model ?? provider?.defaultModel ?? null,
      language: settings.language,
      settings,
    });

    const writeState = (state: Partial<TranscriptionState> & { status: TranscriptionState["status"] }): TranscriptionState => {
      const record = deps.repository.upsert({
        messageRef,
        partIndex,
        fingerprint: fingerprint,
        mediaId,
        status: state.status,
        text: state.text ?? null,
        language: state.language ?? null,
        durationMs: state.durationMs ?? null,
        confidence: state.confidence ?? null,
        provider: state.provider ?? provider?.id ?? null,
        model: state.model ?? settings.model ?? provider?.defaultModel ?? null,
        errorCode: state.errorCode ?? null,
        errorMessage: state.errorMessage ?? null,
        nowIso: deps.clock.nowIso(),
      });
      return record;
    };

    // 前置条件：没有音频引用 / 音频不可用 → 明确失败（不调用 provider，也不影响音频本身）
    if (mediaId === null || part.media.status !== "available") {
      return writeState({
        status: "failed",
        errorCode: "unsupported_audio",
        errorMessage: mediaId === null ? "音频没有可用的媒体引用" : "音频本身不可用（media.status=" + part.media.status + "）",
      });
    }
    // 幂等：已有同一指纹的完成结果 → 直接复用，不再调用 provider（成本控制）
    if (input.force !== true) {
      const cached = deps.repository.findCompleted(messageRef, partIndex, fingerprint);
      if (cached !== null) {
        return sanitizeTranscription({ ...cached, cached: true, updatedAt: cached.updatedAt || now });
      }
    }

    if (provider === null) {
      return writeState({
        status: "failed",
        errorCode: settings.enabled ? "configuration_error" : "disabled",
        errorMessage: settings.enabled ? "没有可用的 ASR provider（未配置或凭据缺失）" : "ASR 未启用",
      });
    }

    const stored = await deps.storage.get(mediaId);
    if (stored === null) {
      return writeState({ status: "failed", errorCode: "unsupported_audio", errorMessage: "媒体存储里找不到这段音频" });
    }
    // 资源限制：超限直接拒绝，连 provider 都不调用（也绝不改音频状态）
    if (stored.bytes.byteLength > settings.maxBytes) {
      deps.logger.warn("asr skipped: audio exceeds maxBytes", { mediaId, bytes: stored.bytes.byteLength, maxBytes: settings.maxBytes });
      return writeState({
        status: "failed",
        errorCode: "too_large",
        errorMessage: "音频超过 ASR 大小上限（" + String(stored.bytes.byteLength) + " > " + String(settings.maxBytes) + "）",
      });
    }
    const durationMs = part.media.durationMs;
    if (durationMs !== null && durationMs > settings.maxDurationMs) {
      deps.logger.warn("asr skipped: audio exceeds maxDurationMs", { mediaId, durationMs, maxDurationMs: settings.maxDurationMs });
      return writeState({
        status: "failed",
        errorCode: "too_long",
        errorMessage: "音频超过 ASR 时长上限（" + String(durationMs) + "ms > " + String(settings.maxDurationMs) + "ms）",
      });
    }

    writeState({ status: "processing" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), settings.timeoutMs);
    const onAbort = (): void => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await provider.transcribe({
        audio: {
          mediaId,
          bytes: stored.bytes,
          mimeType: stored.mimeType,
          durationMs,
          filename: stored.filename,
        },
        language: settings.language,
        model: settings.model,
        signal: controller.signal,
      });
      const text = result.text.trim();
      if (text.length === 0) {
        // provider 返回空文本 = 失败（不能当成"识别成功但没内容"）
        return writeState({ status: "failed", errorCode: "invalid_response", errorMessage: "转写结果为空" });
      }
      const state = writeState({
        status: "completed",
        text,
        language: result.language,
        durationMs: result.durationMs,
        confidence: result.confidence,
        provider: result.providerId,
        model: result.model,
      });
      deps.logger.info("asr completed", {
        mediaId,
        providerId: result.providerId,
        model: result.model,
        latencyMs: result.latencyMs,
        textLength: text.length,
      });
      return state;
    } catch (error) {
      /**
       * 分类顺序很重要：**调用方取消**优先于超时（两者都会让 AbortController 处于 aborted），
       * 而 provider 抛出的具体错误类型不参与这两个判断 —— 只看信号状态才是可靠的。
       */
      const cancelled = input.signal?.aborted === true;
      const timedOut = !cancelled && controller.signal.aborted;
      const { code, message } = cancelled
        ? { code: "aborted", message: "转写被取消" }
        : timedOut
          ? { code: "timeout", message: "转写超时（" + String(settings.timeoutMs) + "ms）" }
          : classifyError(error);
      deps.logger.warn("asr failed", { mediaId, providerId: provider.id, errorCode: code });
      return writeState({ status: "failed", errorCode: code, errorMessage: message });
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    readSettings: () => readAsrSettings(deps.settings),
    transcribeInboundMessage,
    /** 对已经落库的消息部件做（重新）转写；显式调用时 force=true */
    transcribeStoredPart: (input: { part: AudioPart; partIndex: number; messageRef: string; force?: boolean; signal?: AbortSignal }) => {
      const settings = readAsrSettings(deps.settings);
      return transcribePart({
        part: input.part,
        partIndex: input.partIndex,
        messageRef: input.messageRef,
        settings,
        provider: resolveProvider(settings),
        ...(input.force === undefined ? {} : { force: input.force }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
    listByMessage: (messageRef: string): TranscriptionRecord[] => deps.repository.listByMessage(messageRef),
  };
}

export type TranscriptionService = ReturnType<typeof createTranscriptionService>;
