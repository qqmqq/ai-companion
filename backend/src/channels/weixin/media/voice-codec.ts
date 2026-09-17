import { WeixinTransportError } from "../protocol/errors.ts";

/**
 * 微信语音的编解码边界（Phase 4.5-D1）。
 *
 * 这里只做**编解码**，不做任何语音理解：没有 ASR、没有 TTS、没有声纹/情绪识别。
 *
 * 设计要点：
 * - Silk 只存在于微信通道内部：Core 只知道"一段音频字节"（MediaReference + MediaStorage），
 *   不知道 SILK 这个词，更不知道 silk-wasm；
 * - 容器识别（SILK / WAV）用**纯 JS 读魔数**实现，不依赖 wasm 是否加载成功 ——
 *   这样即使编解码库缺失，我们依然能安全地判断"这段字节是什么"，并走降级路径（Phase 0 风险 R6）；
 * - 编解码库通过**可注入的 loader** 延迟加载：测试可以注入假实现，
 *   生产环境缺库时也不会在模块加载期炸掉，而是变成"编解码不可用"的显式状态。
 *
 * 固定参数来自 Phase 0 协议研究：微信语音 24 kHz / 单声道 / 16bit。
 */

/** 微信语音的采样率（Phase 0 研究结论） */
export const VOICE_SAMPLE_RATE = 24000;
export const VOICE_CHANNELS = 1;
export const VOICE_BITS_PER_SAMPLE = 16;

/** 腾讯 SILK 文件头：0x02 + "#!SILK_V3" */
const SILK_LEADING_BYTE = 0x02;
const SILK_MAGIC = "#!SILK_V3";
export const SILK_HEADER_BYTES = SILK_MAGIC.length + 1;
export const WAV_HEADER_BYTES = 44;
/** silk-wasm 支持的采样率集合（裸 PCM 输入时必须落在这个集合里） */
export const SUPPORTED_PCM_SAMPLE_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000] as const;

/** silk-wasm 的最小结构（不直接依赖它的类型定义，便于测试注入假实现） */
export interface SilkModule {
  encode(input: ArrayBufferView | ArrayBuffer, sampleRate: number): Promise<{ data: Uint8Array; duration: number }>;
  decode(input: ArrayBufferView | ArrayBuffer, sampleRate: number): Promise<{ data: Uint8Array; duration: number }>;
}

export interface WavFormat {
  formatCode: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** data chunk 的字节数 */
  dataBytes: number;
}

/** 纯 JS：是不是腾讯 SILK（0x02 + "#!SILK_V3"） */
export function isSilkBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < SILK_HEADER_BYTES) return false;
  if (bytes[0] !== SILK_LEADING_BYTE) return false;
  for (let index = 0; index < SILK_MAGIC.length; index += 1) {
    if (bytes[index + 1] !== SILK_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

/** 纯 JS：是不是 RIFF/WAVE */
export function isWavBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WAV_HEADER_BYTES) return false;
  return (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
  );
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(bytes[offset + index] ?? 0);
  return out;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

/**
 * 只读文件头解析 WAV 的 fmt/data（不是解码、不是重采样、不碰样本数据）。
 * 结构不合法返回 null —— 绝不猜测。
 */
export function readWavFormat(bytes: Uint8Array): WavFormat | null {
  if (!isWavBytes(bytes)) return null;
  let offset = 12;
  let format: Omit<WavFormat, "dataBytes"> | null = null;
  let dataBytes = -1;
  try {
    while (offset + 8 <= bytes.byteLength) {
      const id = readAscii(bytes, offset, 4);
      const size = readUint32LE(bytes, offset + 4);
      const body = offset + 8;
      if (id === "fmt " && body + 16 <= bytes.byteLength) {
        format = {
          formatCode: readUint16LE(bytes, body),
          channels: readUint16LE(bytes, body + 2),
          sampleRate: readUint32LE(bytes, body + 4),
          bitsPerSample: readUint16LE(bytes, body + 14),
        };
      } else if (id === "data") {
        dataBytes = Math.min(size, Math.max(0, bytes.byteLength - body));
      }
      // chunk 长度是奇数时按 RIFF 规范补 1 字节对齐
      offset = body + size + (size % 2);
      if (offset <= body) return null;
    }
  } catch {
    return null;
  }
  if (format === null || dataBytes < 0) return null;
  return { ...format, dataBytes };
}

/** 手工拼 44 字节 WAV 头（与 Phase 0 研究记录的参考实现一致：24 kHz / 单声道 / 16bit） */
export function pcmToWav(
  pcm: Uint8Array,
  format: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {},
): Uint8Array {
  const sampleRate = format.sampleRate ?? VOICE_SAMPLE_RATE;
  const channels = format.channels ?? VOICE_CHANNELS;
  const bitsPerSample = format.bitsPerSample ?? VOICE_BITS_PER_SAMPLE;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = (channels * bitsPerSample) / 8;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

export interface VoiceCodec {
  readonly name: string;
  /** 编解码是否可用（缺库/加载失败时为 false —— 调用方据此走降级路径） */
  available(): Promise<boolean>;
  /** SILK → WAV（24 kHz / 单声道 / 16bit）；失败抛 WeixinTransportError */
  silkToWav(input: Uint8Array): Promise<{ bytes: Uint8Array; durationMs: number }>;
  /**
   * 转成微信需要的 SILK：
   * - 已经是 SILK → 原样返回（**逐字节不变**，不做无意义的转码）
   * - WAV → 编码为 SILK
   * - 其它容器 → 明确拒绝（本阶段没有通用音频解码器，绝不把 MP3 当 PCM 瞎编）
   */
  toSilk(
    input: Uint8Array,
    options?: { treatAsPcm?: { sampleRate: number } },
  ): Promise<{ bytes: Uint8Array; durationMs: number | null; converted: boolean }>;
}

export interface VoiceCodecDeps {
  /** 延迟加载 silk-wasm；测试可注入假实现 */
  load?: () => Promise<SilkModule>;
  sampleRate?: number;
}

async function defaultLoad(): Promise<SilkModule> {
  // 动态 import：库缺失时不会在模块加载期抛错，而是变成一个可判定的"不可用"状态
  const module = (await import("silk-wasm")) as unknown as Partial<SilkModule> & { default?: Partial<SilkModule> };
  const candidate = (module.encode === undefined ? module.default : module) as Partial<SilkModule> | undefined;
  if (candidate === undefined || typeof candidate.encode !== "function" || typeof candidate.decode !== "function") {
    throw new Error("silk-wasm 导出不符合预期");
  }
  return { encode: candidate.encode, decode: candidate.decode };
}

function codecError(action: string, error: unknown): WeixinTransportError {
  const detail = error instanceof Error ? error.message : String(error);
  // 只保留短消息：库的错误信息里不含音频字节，但仍做截断以防万一
  return new WeixinTransportError("protocol_error", action + "失败：" + detail.slice(0, 80), { retryable: false });
}

/**
 * 微信语音编解码实现。日志/异常里**永远不出现**音频字节与密钥，只出现动作与错误类型。
 */
export function createVoiceCodec(deps: VoiceCodecDeps = {}): VoiceCodec {
  const sampleRate = deps.sampleRate ?? VOICE_SAMPLE_RATE;
  const load = deps.load ?? defaultLoad;
  let pending: Promise<SilkModule | null> | null = null;

  async function moduleOrNull(): Promise<SilkModule | null> {
    if (pending === null) {
      pending = load().catch(() => null);
    }
    return pending;
  }

  return {
    name: "silk-wasm",

    async available(): Promise<boolean> {
      return (await moduleOrNull()) !== null;
    },

    async silkToWav(input: Uint8Array): Promise<{ bytes: Uint8Array; durationMs: number }> {
      if (input.byteLength === 0) throw new WeixinTransportError("protocol_error", "语音内容为空", { retryable: false });
      if (!isSilkBytes(input)) throw new WeixinTransportError("protocol_error", "不是 SILK 数据", { retryable: false });
      const module = await moduleOrNull();
      if (module === null) {
        throw new WeixinTransportError("protocol_error", "SILK 编解码不可用（silk-wasm 未安装或加载失败）", { retryable: false });
      }
      let decoded: { data: Uint8Array; duration: number };
      try {
        decoded = await module.decode(input, sampleRate);
      } catch (error) {
        throw codecError("SILK 解码", error);
      }
      if (decoded.data.byteLength === 0) {
        throw new WeixinTransportError("protocol_error", "SILK 解码结果为空", { retryable: false });
      }
      return {
        bytes: pcmToWav(decoded.data),
        durationMs: Number.isFinite(decoded.duration) && decoded.duration >= 0 ? Math.round(decoded.duration) : 0,
      };
    },

    async toSilk(input, options) {
      if (input.byteLength === 0) throw new WeixinTransportError("protocol_error", "语音内容为空", { retryable: false });
      // 已经是 SILK：原样发送（逐字节不变）
      if (isSilkBytes(input)) return { bytes: input, durationMs: null, converted: false };

      const module = await moduleOrNull();
      if (module === null) {
        throw new WeixinTransportError("protocol_error", "SILK 编解码不可用（silk-wasm 未安装或加载失败）", { retryable: false });
      }

      let rate = 0;
      if (isWavBytes(input)) {
        const format = readWavFormat(input);
        if (format === null) throw new WeixinTransportError("protocol_error", "WAV 文件头不可解析", { retryable: false });
        if (!SUPPORTED_PCM_SAMPLE_RATES.includes(format.sampleRate as (typeof SUPPORTED_PCM_SAMPLE_RATES)[number])) {
          throw new WeixinTransportError("protocol_error", "WAV 采样率不受支持", { retryable: false });
        }
        // WAV 自带采样率：按库的约定传 0
        rate = 0;
      } else if (options?.treatAsPcm !== undefined) {
        if (!SUPPORTED_PCM_SAMPLE_RATES.includes(options.treatAsPcm.sampleRate as (typeof SUPPORTED_PCM_SAMPLE_RATES)[number])) {
          throw new WeixinTransportError("protocol_error", "PCM 采样率不受支持", { retryable: false });
        }
        if (input.byteLength % 2 !== 0) throw new WeixinTransportError("protocol_error", "PCM 字节数不是 16bit 对齐", { retryable: false });
        rate = options.treatAsPcm.sampleRate;
      } else {
        // 没有通用音频解码器：明确拒绝，绝不把未知容器当 PCM 处理
        throw new WeixinTransportError("protocol_error", "不支持的音频容器（只支持 SILK 与 WAV）", { retryable: false });
      }

      let encoded: { data: Uint8Array; duration: number };
      try {
        encoded = await module.encode(input, rate);
      } catch (error) {
        throw codecError("SILK 编码", error);
      }
      if (encoded.data.byteLength === 0) {
        throw new WeixinTransportError("protocol_error", "SILK 编码结果为空", { retryable: false });
      }
      return {
        bytes: encoded.data,
        durationMs: Number.isFinite(encoded.duration) && encoded.duration >= 0 ? Math.round(encoded.duration) : null,
        converted: true,
      };
    },
  };
}
