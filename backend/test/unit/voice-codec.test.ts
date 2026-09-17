import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SILK_HEADER_BYTES,
  SUPPORTED_PCM_SAMPLE_RATES,
  VOICE_BITS_PER_SAMPLE,
  VOICE_CHANNELS,
  VOICE_SAMPLE_RATE,
  createVoiceCodec,
  isSilkBytes,
  isWavBytes,
  pcmToWav,
  readWavFormat,
  type SilkModule,
} from "../../src/channels/weixin/media/voice-codec.ts";
import { WeixinTransportError } from "../../src/channels/weixin/protocol/errors.ts";

/** 生成一段 16bit 单声道 PCM（正弦波），可指定采样数 */
function pcm(samples: number, sampleRate = VOICE_SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(samples * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(12000 * Math.sin((2 * Math.PI * 440 * index) / sampleRate));
    view.setInt16(index * 2, value, true);
  }
  return out;
}

function kindOf(error: unknown): string {
  assert.ok(error instanceof WeixinTransportError, "expected WeixinTransportError, got " + String(error));
  return (error as WeixinTransportError).kind;
}

test("SILK/WAV detection and WAV header parsing are pure JS (no wasm needed)", () => {
  const silkLike = new Uint8Array([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33]); // 0x02 + "#!SILK_V3"
  assert.equal(isSilkBytes(silkLike), true);
  assert.equal(SILK_HEADER_BYTES, 10);
  assert.equal(isSilkBytes(silkLike.slice(0, 5)), false, "被截断的 SILK 头不算 SILK");
  assert.equal(isSilkBytes(new Uint8Array([0x02, 0x23, 0x21])), false);
  assert.equal(isSilkBytes(new Uint8Array(0)), false);

  const wav = pcmToWav(pcm(240), { sampleRate: 16000, channels: 2, bitsPerSample: 16 });
  assert.equal(isWavBytes(wav), true);
  const format = readWavFormat(wav);
  assert.ok(format !== null);
  assert.equal(format.sampleRate, 16000);
  assert.equal(format.channels, 2);
  assert.equal(format.bitsPerSample, 16);
  assert.equal(format.dataBytes, 240 * 2);
  assert.equal(isWavBytes(new Uint8Array([0x52, 0x49, 0x46, 0x46])), false, "只有 RIFF 前缀不是 WAV");
  assert.equal(readWavFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x57, 0x41, 0x56, 0x45])), null);
});

test("pcmToWav writes a canonical 44-byte header for the project default (24 kHz mono 16bit)", () => {
  const body = pcm(480);
  const wav = pcmToWav(body);
  assert.equal(wav.byteLength, 44 + body.byteLength);
  assert.equal(Buffer.from(wav.slice(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.slice(8, 12)).toString("ascii"), "WAVE");
  assert.equal(Buffer.from(wav.slice(36, 40)).toString("ascii"), "data");
  const format = readWavFormat(wav);
  assert.equal(format?.sampleRate, VOICE_SAMPLE_RATE);
  assert.equal(format?.channels, VOICE_CHANNELS);
  assert.equal(format?.bitsPerSample, VOICE_BITS_PER_SAMPLE);
});

test("real codec: encode → decode round-trips into decodable 24 kHz mono 16bit audio", async () => {
  const codec = createVoiceCodec();
  assert.equal(await codec.available(), true, "silk-wasm 必须可用（它是 runtime dependency）");

  const sourcePcm = pcm(VOICE_SAMPLE_RATE); // 恰好 1 秒
  const encoded = await codec.toSilk(pcmToWav(sourcePcm));
  assert.equal(encoded.converted, true);
  assert.equal(isSilkBytes(encoded.bytes), true, "编码结果必须是 SILK");
  assert.ok(encoded.bytes.byteLength > 0);
  assert.ok(encoded.durationMs !== null && encoded.durationMs > 0, "编码器给出真实时长");

  const decoded = await codec.silkToWav(encoded.bytes);
  assert.equal(isWavBytes(decoded.bytes), true, "解码结果必须是 WAV");
  const format = readWavFormat(decoded.bytes);
  assert.ok(format !== null);
  assert.equal(format.sampleRate, VOICE_SAMPLE_RATE, "采样率 24 kHz");
  assert.equal(format.channels, VOICE_CHANNELS, "单声道");
  assert.equal(format.bitsPerSample, VOICE_BITS_PER_SAMPLE, "16bit");
  assert.ok(format.dataBytes > 0, "解码结果非空");

  /**
   * SILK 是**有损**编解码，逐字节一致是不成立的；这里断言的是**帧级量化**这个真实性质：
   * SILK 以 20ms 为一帧，1 秒输入解码回来是 1040ms（多出一帧边界），因此容差取 2 帧 = 40ms。
   * 这个数字来自实测（见本阶段报告），不是拍脑袋定的。
   */
  assert.ok(decoded.durationMs >= 1000 && decoded.durationMs <= 1000 + 40, "时长在帧量化容差内：" + String(decoded.durationMs));

  // 同一段 SILK 解码两次必须完全一致（确定性），这是可断言的不变量
  const again = await codec.silkToWav(encoded.bytes);
  assert.equal(Buffer.compare(Buffer.from(again.bytes), Buffer.from(decoded.bytes)), 0);

  // WAV → SILK → 再编码一次仍是合法 SILK（幂等编码路径）
  const reencoded = await codec.toSilk(decoded.bytes);
  assert.equal(isSilkBytes(reencoded.bytes), true);
});

test("already-SILK input is passed through byte-for-byte without re-encoding", async () => {
  const codec = createVoiceCodec();
  const silk = (await codec.toSilk(pcmToWav(pcm(2400)))).bytes;
  const passthrough = await codec.toSilk(silk);
  assert.equal(passthrough.converted, false, "已是 SILK 不做转码");
  assert.equal(Buffer.compare(Buffer.from(passthrough.bytes), Buffer.from(silk)), 0, "必须逐字节不变");
  assert.equal(passthrough.durationMs, null, "不做无必要的解码，所以不报时长");
});

test("raw PCM is only accepted when the caller explicitly says so", async () => {
  const codec = createVoiceCodec();
  const rawPcm = pcm(4800);
  await assert.rejects(
    () => codec.toSilk(rawPcm),
    (error: unknown) => {
      assert.equal(kindOf(error), "protocol_error");
      assert.match((error as Error).message, /只支持 SILK 与 WAV/);
      return true;
    },
    "未知容器不能被当成 PCM 瞎编",
  );

  const encoded = await codec.toSilk(rawPcm, { treatAsPcm: { sampleRate: VOICE_SAMPLE_RATE } });
  assert.equal(isSilkBytes(encoded.bytes), true);

  // 奇数长度不是 16bit 对齐 → 明确拒绝
  await assert.rejects(
    () => codec.toSilk(new Uint8Array([1, 2, 3]), { treatAsPcm: { sampleRate: VOICE_SAMPLE_RATE } }),
    (error: unknown) => kindOf(error) === "protocol_error",
  );
  // 不支持的采样率 → 明确拒绝
  await assert.rejects(
    () => codec.toSilk(rawPcm, { treatAsPcm: { sampleRate: 12345 } }),
    (error: unknown) => kindOf(error) === "protocol_error",
  );
  assert.equal(SUPPORTED_PCM_SAMPLE_RATES.includes(24000), true);
});

test("invalid, empty and truncated inputs fail cleanly (never a wrong result)", async () => {
  const codec = createVoiceCodec();

  // 空输入
  await assert.rejects(
    () => codec.silkToWav(new Uint8Array(0)),
    (error: unknown) => kindOf(error) === "protocol_error",
  );
  // 不是 SILK 的数据
  for (const notSilk of [new Uint8Array([1, 2, 3]), new TextEncoder().encode("hello world"), pcmToWav(pcm(24))]) {
    await assert.rejects(
      () => codec.silkToWav(notSilk),
      (error: unknown) => {
        assert.equal(kindOf(error), "protocol_error");
        assert.match((error as Error).message, /不是 SILK 数据/);
        return true;
      },
    );
  }

  // 损坏的 SILK：头部合法但内容随机 → 解码必须报错（不能返回"看起来能用"的结果）
  const header = new Uint8Array([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33]);
  const corrupt = new Uint8Array(header.byteLength + 64);
  corrupt.set(header, 0);
  for (let index = header.byteLength; index < corrupt.byteLength; index += 1) corrupt[index] = (index * 37) % 256;
  await assert.rejects(
    () => codec.silkToWav(corrupt),
    (error: unknown) => {
      assert.equal(kindOf(error), "protocol_error");
      assert.equal((error as WeixinTransportError).retryable, false, "编解码错误不可重试");
      return true;
    },
  );

  /**
   * 截断的 SILK：silk-wasm 的行为是**按帧尽力解码**（不抛错，返回更短的音频）。
   * 这是实测行为，因此这里断言"不会崩、不会给出比完整解码更多的数据"，
   * 而不是假设它一定抛错。
   */
  const full = (await codec.toSilk(pcmToWav(pcm(VOICE_SAMPLE_RATE)))).bytes;
  const truncated = await codec.silkToWav(full.slice(0, Math.floor(full.byteLength / 4)));
  const fullDecoded = await codec.silkToWav(full);
  assert.ok(truncated.bytes.byteLength > 0);
  assert.ok(truncated.bytes.byteLength <= fullDecoded.bytes.byteLength, "截断输入不可能解出更多音频");
});

test("a missing codec degrades to an explicit unavailable state instead of crashing", async () => {
  const failing = createVoiceCodec({
    load: async () => {
      throw new Error("module not found");
    },
  });
  assert.equal(await failing.available(), false, "缺库时必须是可判定的不可用，而不是抛错");
  await assert.rejects(
    () => failing.silkToWav(new Uint8Array([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33])),
    (error: unknown) => {
      assert.equal(kindOf(error), "protocol_error");
      assert.match((error as Error).message, /SILK 编解码不可用/);
      return true;
    },
  );
  await assert.rejects(
    () => failing.toSilk(pcmToWav(pcm(48))),
    (error: unknown) => kindOf(error) === "protocol_error",
  );

  // 注入假实现：编解码边界可替换（Core 与通道都不依赖具体库）
  const fake: SilkModule = {
    encode: async () => ({ data: new Uint8Array([0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33, 0x41]), duration: 20 }),
    decode: async () => ({ data: new Uint8Array([1, 0, 2, 0]), duration: 20 }),
  };
  const injected = createVoiceCodec({ load: async () => fake });
  assert.equal(await injected.available(), true);
  const encoded = await injected.toSilk(pcmToWav(pcm(96)));
  assert.equal(encoded.converted, true);
  const decoded = await injected.silkToWav(encoded.bytes);
  assert.deepEqual([...decoded.bytes.slice(44)], [1, 0, 2, 0], "解码出的 PCM 被包进 WAV");
  assert.equal(decoded.durationMs, 20);
});

test("silk-wasm is a runtime dependency, not a devDependency (Phase 0 risk R6)", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.ok(manifest.dependencies?.["silk-wasm"] !== undefined, "silk-wasm 必须在 dependencies 里（生产安装也要有）");
  assert.equal(manifest.devDependencies?.["silk-wasm"], undefined, "不能只声明成 devDependency");
});

test("the codec layer never logs and never touches the network", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "channels", "weixin", "media", "voice-codec.ts"), "utf8");
  assert.equal(/console\.(log|info|warn|error|debug)/.test(source), false);
  assert.equal(/\bfetch\s*\(/.test(source), false);
  assert.equal(/logger/.test(source), false);
  // 只允许加载 silk-wasm 这一个编解码库
  const imports = [...source.matchAll(/import\((?:"|')([^"']+)(?:"|')\)/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["silk-wasm"]);
});
