import type { MediaStorage } from "../ports/media-storage.ts";
import type { TtsProvider, TtsProviderRegistry, TtsOutputFormat } from "../ports/tts.ts";
import type { TtsSynthesisRepository } from "../ports/repositories.phase45.ts";
import type { SettingsRepository } from "../ports/repositories.ts";
import type { Logger } from "../ports/logger.ts";
import type { Clock } from "../ports/clock.ts";
import { ProviderError, type ProviderErrorKind } from "../model/provider-error.ts";
import { isSupportedTtsFormat, sanitizeTtsState, TTS_LIMITS, type TtsState } from "../model/tts.ts";
import { stableHash64 } from "../../util/hash.ts";
import { createKeyedLock, type KeyedLock } from "../../util/keyed-lock.ts";

/**
 * 语音合成服务（Phase 4.5-D4）。
 *
 * 职责边界：
 * - 只做"文本 → 音频字节 → MediaStorage"这一件事；**不生成记忆**、**不回灌 ASR**；
 * - 文本是权威的：合成失败只影响"有没有语音"，绝不影响已经生成/已发送的文字回复；
 * - 结果只把 **mediaId + 元数据** 交给上层，音频字节永远只在 MediaStorage；
 * - 幂等/缓存由**指纹**决定：provider + model + voice + language + speed + format + 文本哈希。
 *
 * 隐私：日志里只有 providerId、模型、音色、文本长度、字节数、耗时与错误分类，
 * **没有**完整待合成文本，也**没有**音频字节。
 */

export interface TtsSettings {
  enabled: boolean;
  providerId: string | null;
  model: string | null;
  voice: string | null;
  language: string | null;
  speed: number | null;
  timeoutMs: number;
  maxTextLength: number;
  outputFormat: TtsOutputFormat;
  /** 投递方式：原生语音 / 音频文件 / 只回文本（简单三选一，不做媒体路由系统） */
  delivery: "voice" | "file" | "text";
  configVersion: string;
}

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
  enabled: false,
  providerId: null,
  model: null,
  voice: null,
  language: null,
  speed: null,
  timeoutMs: 20_000,
  maxTextLength: TTS_LIMITS.maxTextLength,
  outputFormat: "wav",
  delivery: "voice",
  configVersion: "v1",
};

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readTtsSettings(settings: SettingsRepository): TtsSettings {
  const format = settings.get<string>("tts.outputFormat", DEFAULT_TTS_SETTINGS.outputFormat);
  const delivery = settings.get<string>("tts.delivery", DEFAULT_TTS_SETTINGS.delivery);
  const speed = settings.get<number | null>("tts.speed", null);
  return {
    enabled: settings.get<boolean>("tts.enabled", DEFAULT_TTS_SETTINGS.enabled),
    providerId: settings.get<string | null>("tts.providerId", DEFAULT_TTS_SETTINGS.providerId),
    model: settings.get<string | null>("tts.model", DEFAULT_TTS_SETTINGS.model),
    voice: settings.get<string | null>("tts.voice", DEFAULT_TTS_SETTINGS.voice),
    language: settings.get<string | null>("tts.language", DEFAULT_TTS_SETTINGS.language),
    speed: typeof speed === "number" && Number.isFinite(speed) && speed > 0 ? speed : null,
    timeoutMs: readNumber(settings.get<number>("tts.timeoutMs", DEFAULT_TTS_SETTINGS.timeoutMs), DEFAULT_TTS_SETTINGS.timeoutMs),
    maxTextLength: readNumber(settings.get<number>("tts.maxTextLength", DEFAULT_TTS_SETTINGS.maxTextLength), DEFAULT_TTS_SETTINGS.maxTextLength),
    outputFormat: isSupportedTtsFormat(format) ? format : DEFAULT_TTS_SETTINGS.outputFormat,
    delivery: delivery === "file" || delivery === "text" ? delivery : "voice",
    configVersion: settings.get<string>("tts.configVersion", DEFAULT_TTS_SETTINGS.configVersion),
  };
}

export interface TtsServiceDeps {
  /** 测试可注入；默认是进程内按指纹串行化的互斥锁（防止并发重复合成与重复媒体） */
  lock?: KeyedLock;
  registry: TtsProviderRegistry;
  repository: TtsSynthesisRepository;
  storage: MediaStorage;
  settings: SettingsRepository;
  logger: Logger;
  clock: Clock;
}

export interface SynthesizeOptions {
  signal?: AbortSignal;
  /** 显式重新合成：忽略已有缓存 */
  force?: boolean;
  /** 这条合成结果属于哪条消息（仅用于可观测性） */
  messageRef?: string | null;
}

export interface SynthesizeResult {
  state: TtsState;
  /** 是否真的调用了 provider（false = 命中缓存 / 未启用 / 被限额拒绝） */
  providerCalled: boolean;
  /** 审计用：缓存键 */
  fingerprint: string;
}

export function createTtsService(deps: TtsServiceDeps) {
  const lock = deps.lock ?? createKeyedLock();
  /** 确定性指纹（缓存与幂等的唯一依据） */
  function fingerprintOf(input: { settings: TtsSettings; providerId: string; text: string }): { fingerprint: string; textHash: string } {
    // 纯 JS 稳定哈希：Core 不允许引入 node: 或第三方模块（ARCH-2/ARCH-6）
    const textHash = stableHash64(input.text);
    const fingerprint = [
      input.settings.configVersion,
      input.providerId,
      input.settings.model ?? "-",
      input.settings.voice ?? "-",
      input.settings.language ?? "-",
      input.settings.speed === null ? "-" : String(input.settings.speed),
      input.settings.outputFormat,
      textHash,
    ].join("|");
    return { fingerprint, textHash };
  }

  function writeState(input: {
    fingerprint: string;
    textHash: string;
    textLength: number;
    providerId: string | null;
    settings: TtsSettings;
    messageRef: string | null;
    state: Partial<TtsState> & { status: TtsState["status"] };
  }): TtsState {
    const record = deps.repository.upsert({
      fingerprint: input.fingerprint,
      status: input.state.status,
      mediaId: input.state.mediaId ?? null,
      mimeType: input.state.mimeType ?? null,
      durationMs: input.state.durationMs ?? null,
      sampleRate: input.state.sampleRate ?? null,
      provider: input.state.provider ?? input.providerId,
      model: input.state.model ?? input.settings.model,
      voice: input.state.voice ?? input.settings.voice,
      language: input.settings.language,
      format: input.settings.outputFormat,
      textHash: input.textHash,
      textLength: input.textLength,
      errorCode: input.state.errorCode ?? null,
      errorMessage: input.state.errorMessage ?? null,
      messageRef: input.messageRef,
      nowIso: deps.clock.nowIso(),
    });
    return sanitizeTtsState({ ...record, cached: input.state.cached === true });
  }

  function resolveProvider(settings: TtsSettings): TtsProvider | null {
    if (!settings.enabled) return null;
    if (settings.providerId === null || settings.providerId.length === 0) return null;
    return deps.registry.get(settings.providerId) ?? null;
  }

  function classify(error: unknown): { code: string; message: string } {
    if (error instanceof ProviderError) return { code: error.providerKind as ProviderErrorKind, message: error.message };
    if (error instanceof Error && error.name === "AbortError") return { code: "aborted", message: "语音合成被取消" };
    return { code: "unknown", message: error instanceof Error ? error.message : String(error) };
  }

  /**
   * 文本 → 音频（写入 MediaStorage）→ 状态。任何失败都只体现为 state.status = "failed"。
   *
   * Phase 4.5-E：按"文本 + 配置"指纹串行化。并发重复请求（前端连点、自动 + 显式重试同时到达）
   * 过去会双双错过缓存 → 重复调用 provider + 产生两份媒体对象；串行化后只有第一个真正合成。
   */
  async function synthesizeForText(text: string, options: SynthesizeOptions = {}): Promise<SynthesizeResult> {
    const trimmedForLock = text.trim();
    const settingsForLock = readTtsSettings(deps.settings);
    const providerForLock = resolveProvider(settingsForLock);
    const { fingerprint: lockFingerprint } = fingerprintOf({
      settings: settingsForLock,
      providerId: providerForLock?.id ?? settingsForLock.providerId ?? "-",
      text: trimmedForLock,
    });
    const lockKey = lockFingerprint + (options.force === true ? ":force" : "");
    return lock.runExclusive(lockKey, () => synthesizeForTextUnlocked(text, options));
  }

  async function synthesizeForTextUnlocked(text: string, options: SynthesizeOptions = {}): Promise<SynthesizeResult> {
    const settings = readTtsSettings(deps.settings);
    const provider = resolveProvider(settings);
    const trimmed = text.trim();
    const textLength = trimmed.length;
    const providerId = provider?.id ?? settings.providerId ?? "-";
    const { fingerprint, textHash } = fingerprintOf({ settings, providerId, text: trimmed });
    const messageRef = options.messageRef ?? null;
    const base = { fingerprint, textHash, textLength, providerId: provider?.id ?? null, settings, messageRef };

    if (trimmed.length === 0) {
      return { state: writeState({ ...base, state: { status: "skipped", errorCode: "too_long", errorMessage: "没有可合成的文本" } }), providerCalled: false, fingerprint };
    }
    if (provider === null) {
      return {
        state: writeState({
          ...base,
          state: {
            status: "failed",
            errorCode: settings.enabled ? "configuration_error" : "disabled",
            errorMessage: settings.enabled ? "没有可用的 TTS provider（未配置或凭据缺失）" : "TTS 未启用",
          },
        }),
        providerCalled: false,
        fingerprint,
      };
    }
    // 限额：**在调用 provider 之前**拒绝
    if (textLength > settings.maxTextLength) {
      deps.logger.warn("tts skipped: text exceeds maxTextLength", { textLength, maxTextLength: settings.maxTextLength });
      return {
        state: writeState({ ...base, state: { status: "failed", errorCode: "too_long", errorMessage: "文本超过 TTS 长度上限（" + String(textLength) + " > " + String(settings.maxTextLength) + "）" } }),
        providerCalled: false,
        fingerprint,
      };
    }
    if (!isSupportedTtsFormat(settings.outputFormat)) {
      return {
        state: writeState({ ...base, state: { status: "failed", errorCode: "unsupported_format", errorMessage: "不支持的输出格式" } }),
        providerCalled: false,
        fingerprint,
      };
    }

    // 缓存：同一指纹的已完成结果直接复用（不重复合成 = 不重复付费）
    if (options.force !== true) {
      const cached = deps.repository.findCompleted(fingerprint);
      if (cached !== null && cached.mediaId !== null && cached.textLength === textLength) {
        deps.logger.info("tts cache hit", { providerId, mediaId: cached.mediaId, textLength });
        return { state: sanitizeTtsState({ ...cached, cached: true }), providerCalled: false, fingerprint };
      }
    }

    writeState({ ...base, state: { status: "processing" } });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("timeout")), settings.timeoutMs);
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await provider.synthesize({
        text: trimmed,
        voice: settings.voice,
        language: settings.language,
        model: settings.model,
        speed: settings.speed,
        format: settings.outputFormat,
        signal: controller.signal,
      });
      if (result.bytes.byteLength === 0) {
        return { state: writeState({ ...base, state: { status: "failed", errorCode: "invalid_response", errorMessage: "合成返回了空音频" } }), providerCalled: true, fingerprint };
      }

      // 音频只进 MediaStorage（origin = "generated"：这是系统生成的内容，不是渠道来的）
      const asset = await deps.storage.put({
        bytes: result.bytes,
        mimeType: result.mimeType,
        filename: null,
        origin: "generated",
      });
      const state = writeState({
        ...base,
        state: {
          status: "completed",
          mediaId: asset.mediaId,
          mimeType: result.mimeType,
          durationMs: result.durationMs,
          sampleRate: result.sampleRate,
          provider: result.providerId,
          model: result.model,
          voice: result.voice,
        },
      });
      deps.logger.info("tts completed", {
        providerId: result.providerId,
        model: result.model,
        voice: result.voice,
        mediaId: asset.mediaId,
        bytes: asset.sizeBytes,
        textLength,
        latencyMs: result.latencyMs,
      });
      return { state, providerCalled: true, fingerprint };
    } catch (error) {
      const cancelled = options.signal?.aborted === true;
      const timedOut = !cancelled && controller.signal.aborted;
      const { code, message } = cancelled
        ? { code: "aborted", message: "语音合成被取消" }
        : timedOut
          ? { code: "timeout", message: "语音合成超时（" + String(settings.timeoutMs) + "ms）" }
          : classify(error);
      deps.logger.warn("tts failed", { providerId, errorCode: code });
      return { state: writeState({ ...base, state: { status: "failed", errorCode: code, errorMessage: message } }), providerCalled: true, fingerprint };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    readSettings: () => readTtsSettings(deps.settings),
    synthesizeForText,
    /** 供 API/测试使用：这条消息产生过哪些合成记录 */
    listForMessage: (messageRef: string) => deps.repository.listForMessage(messageRef),
  };
}

export type TtsService = ReturnType<typeof createTtsService>;
