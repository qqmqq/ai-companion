import type { TranscriptionState, TranscriptionStatus } from "../model/transcription.ts";
import type { TtsStatus } from "../model/tts.ts";

/**
 * 转写的持久化端口（Phase 4.5-D3）。
 *
 * 一条"转写记录"对应"某条消息里的某个音频部件"：
 * - 只保存文本与元数据，**绝不保存音频字节**（音频永远只在 MediaStorage 里）；
 * - \`fingerprint\` 用于幂等：同一个音频 + 同一个 provider/model 只会真正识别一次。
 */
export interface TranscriptionRecord extends TranscriptionState {
  /** 消息标识：入站消息用渠道消息 id（providerMessageId），落库后用 message id */
  messageRef: string;
  partIndex: number;
  /** 参与幂等判定的指纹（音频 + provider + model + 语言 + 配置版本） */
  fingerprint: string;
  /** 音频的 MediaStorage 引用，便于审计与重新转写 */
  mediaId: string | null;
  createdAt: string;
}

export interface TranscriptionUpsertInput {
  messageRef: string;
  partIndex: number;
  fingerprint: string;
  mediaId: string | null;
  status: TranscriptionStatus;
  text?: string | null;
  language?: string | null;
  durationMs?: number | null;
  confidence?: number | null;
  provider?: string | null;
  model?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  nowIso: string;
}

export interface TranscriptionRepository {
  upsert(input: TranscriptionUpsertInput): TranscriptionRecord;
  /** 精确命中（消息 + 部件），不存在返回 null */
  get(messageRef: string, partIndex: number): TranscriptionRecord | null;
  listByMessage(messageRef: string): TranscriptionRecord[];
  /** 已完成的记录，用于幂等复用：指纹不同则视为需要重新识别 */
  findCompleted(messageRef: string, partIndex: number, fingerprint: string): TranscriptionRecord | null;
  delete(messageRef: string, partIndex: number): boolean;
  /**
   * Phase 4.5-E：把"卡在 processing"的记录收敛掉。
   *
   * 进程在转写途中崩溃时，记录会永远停在 processing（没有后台任务会再来收尾）。
   * 启动时调用一次：把 updatedAt 早于 cutoff 的 processing 记录标成 failed(interrupted)，
   * 于是状态是**可观测**的，用户/API 可以显式重试 —— 而不是永远转圈。
   */
  recoverInterrupted(cutoffIso: string, nowIso: string): number;
}
/**
 * 语音合成（TTS）的持久化端口（Phase 4.5-D4）。
 *
 * 只保存"合成结果的引用与元数据"：
 * - `fingerprint` 是缓存/幂等的唯一键（provider + model + voice + language + speed + format + 文本哈希）；
 * - 音频字节永远只在 MediaStorage，**绝不进库**。
 */
export interface TtsSynthesisRecord {
  fingerprint: string;
  status: TtsStatus;
  mediaId: string | null;
  mimeType: string | null;
  durationMs: number | null;
  sampleRate: number | null;
  provider: string | null;
  model: string | null;
  voice: string | null;
  language: string | null;
  format: string | null;
  textHash: string | null;
  textLength: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  messageRef: string | null;
  cached: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TtsSynthesisUpsertInput {
  fingerprint: string;
  status: TtsStatus;
  mediaId?: string | null;
  mimeType?: string | null;
  durationMs?: number | null;
  sampleRate?: number | null;
  provider?: string | null;
  model?: string | null;
  voice?: string | null;
  language?: string | null;
  format?: string | null;
  textHash?: string | null;
  textLength?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  messageRef?: string | null;
  nowIso: string;
}

export interface TtsSynthesisRepository {
  upsert(input: TtsSynthesisUpsertInput): TtsSynthesisRecord;
  get(fingerprint: string): TtsSynthesisRecord | null;
  /** 命中"已完成"的缓存时才返回（失败/中间态不算缓存） */
  findCompleted(fingerprint: string): TtsSynthesisRecord | null;
  listForMessage(messageRef: string): TtsSynthesisRecord[];
  /** 同 TranscriptionRepository.recoverInterrupted：把崩溃遗留的 processing 记录收敛成 failed */
  recoverInterrupted(cutoffIso: string, nowIso: string): number;
}
