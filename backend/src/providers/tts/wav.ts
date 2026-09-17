import { TTS_FORMAT_MIME } from "../../core/model/tts.ts";

/**
 * 最小 WAV 容器写入（Phase 4.5-D4，provider 层私有工具）。
 *
 * 为什么这里有一份而不是复用渠道里的实现：
 * 依赖方向不允许 provider 层依赖任何具体渠道（那会让 provider 被某个渠道绑架，
 * 也会让"物理删除某个渠道目录后 src 仍能类型检查"（ARCH-7）不成立）。
 * SILK 编解码仍然只有一处（在渠道内部），这里只负责把 PCM 包成最普通的 44 字节 WAV 头，
 * 参数与 D1 的约定保持一致：24 kHz / 单声道 / 16bit。
 */

export const VOICE_SAMPLE_RATE = 24000;
export const WAV_HEADER_BYTES = 44;

export function pcmToWav(
  pcm: Uint8Array,
  format: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {},
): Uint8Array {
  const sampleRate = format.sampleRate ?? VOICE_SAMPLE_RATE;
  const channels = format.channels ?? 1;
  const bitsPerSample = format.bitsPerSample ?? 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

export const WAV_MIME = TTS_FORMAT_MIME.wav;
