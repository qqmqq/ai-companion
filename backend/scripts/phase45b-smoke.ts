/**
 * Phase 4.5-B 冒烟：真实进程 + 真实 HTTP + 真实文件系统 + mock 微信后端 + mock CDN。
 *
 * 验证链路：
 *   随机媒体 → AES-128-ECB/PKCS#7 加密 → getuploadurl → CDN 上传 → CDN 下载 → 解密 → Buffer.equals 原字节
 * 同时验证平台无关的 MediaStorage（媒体只落盘，消息里只留 mediaId）。
 *
 * 用法：node scripts/phase45b-smoke.ts [dataDir]
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockCdnServer } from "../test/helpers/mock-weixin-cdn.ts";
import { startMockWeixinServer } from "../test/helpers/mock-weixin-server.ts";
import { loadConfig } from "../src/app/config.ts";
import { createContainer, startChannels } from "../src/app/bootstrap.ts";
import type { WeixinChannel } from "../src/channels/weixin/channel.ts";
import { MEDIA_SECRET_KEYS } from "../src/channels/weixin/media/media-transport.ts";
import { encryptedSize, mediaKeyFromProtocolBase64 } from "../src/channels/weixin/media/aes-media.ts";
import { MEDIA_LIMITS } from "../src/core/model/media.ts";

const dataDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "companion-p45b-"));
const cleanup = process.argv[2] === undefined;
const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const cdn = await startMockCdnServer();
const weixin = await startMockWeixinServer({
  qrStatuses: ["confirmed"],
  botToken: "token-media-smoke",
  accountId: "wx-media-account",
  ilinkUserId: "self-media",
  cdnBaseUrl: cdn.baseUrl,
});

const config = loadConfig({ COMPANION_DATA_DIR: dataDir, COMPANION_LOG_LEVEL: "warn", COMPANION_SCHEDULER_ENABLED: "false" });
const container = await createContainer({
  config,
  fetchImpl: fetch,
  settingsSeed: { "weixin.baseUrl": weixin.baseUrl, "weixin.cdnBaseUrl": cdn.baseUrl },
});
await startChannels(container);

try {
  log(`DATA DIR: ${dataDir}`);
  log(`MOCK WEIXIN: ${weixin.baseUrl} / MOCK CDN: ${cdn.baseUrl}`);

  // 登录（复用 Phase 4 的登录流程）
  const channel = container.channels.get("weixin") as WeixinChannel;
  const session = await channel.startLogin();
  await channel.pollLogin(session.sessionId);
  const finished = await channel.pollLogin(session.sessionId);
  const { accountId } = await channel.completeLogin(session.sessionId);
  await channel.stop();
  log(`LOGIN: phase=${finished?.phase} account=${accountId}`);

  // 1) 平台无关的媒体存储：字节只落盘，返回 mediaId
  const original = new Uint8Array(randomBytes(3000));
  const asset = await container.mediaStorage.put({ bytes: original, mimeType: "image/png", filename: "smoke.png", origin: "generated" });
  const readBack = await container.mediaStorage.get(asset.mediaId);
  log(
    `MEDIA STORAGE: mediaId=${asset.mediaId.slice(0, 8)}… size=${asset.sizeBytes} checksum=${asset.checksum.slice(0, 12)}… bytes-equal=${
      readBack !== null && Buffer.compare(Buffer.from(readBack.bytes), Buffer.from(original)) === 0
    }`,
  );

  // 2) 微信媒体传输：加密 → 上传 → 下载 → 解密
  const transport = await channel.createMediaTransport(accountId);
  const uploaded = await transport.upload({
    accountId,
    conversationRef: "wx-user-media",
    kind: "image",
    bytes: original,
    mimeType: "image/png",
    filename: "smoke.png",
  });
  const uploadCall = weixin.calls.find((call) => call.path.endsWith("/ilink/bot/getuploadurl"));
  const uploadBody = (uploadCall?.body ?? {}) as Record<string, unknown>;
  log(
    `GETUPLOADURL: media_type=${uploadBody.media_type} rawsize=${uploadBody.rawsize} filesize=${uploadBody.filesize} (= encryptedSize ${encryptedSize(original.byteLength)}) no_need_thumb=${uploadBody.no_need_thumb}`,
  );

  const storedCiphertext = [...cdn.stored.values()][0]!;
  log(
    `CDN UPLOAD: ciphertext=${storedCiphertext.byteLength} 字节 / 明文=${original.byteLength} 字节 / 与明文不同=${
      Buffer.compare(Buffer.from(storedCiphertext), Buffer.from(original)) !== 0
    }`,
  );

  const downloaded = await transport.download({
    accountId,
    handle: uploaded.handle,
    secretMaterial: uploaded.secretMaterial,
    expectedMimeType: "image/png",
  });
  const identical = Buffer.compare(Buffer.from(downloaded.bytes), Buffer.from(original)) === 0;
  log(`DOWNLOAD+DECRYPT: ${downloaded.sizeBytes} 字节 / Buffer.equals(原始) = ${identical}`);

  // 3) 敏感材料不进日志/引用
  const secretKey = uploaded.secretMaterial[MEDIA_SECRET_KEYS.mediaKey]!;
  const secretParam = uploaded.secretMaterial[MEDIA_SECRET_KEYS.encryptQueryParam]!;
  log(`SECRET SPLIT: handle 里含密钥=${JSON.stringify(uploaded.handle).includes(secretKey)} / 密钥长度=${mediaKeyFromProtocolBase64(secretKey).byteLength} 字节 / 下载参数不下发到 handle=${JSON.stringify(uploaded.handle).includes(secretParam)}`);

  // 4) 失败路径：篡改密文必须解不出来，而且不能返回半截数据
  const param = secretParam;
  const tampered = Buffer.from(cdn.stored.get(param)!);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
  cdn.stored.set(param, tampered);
  let tamperError = "(未报错)";
  try {
    await transport.download({ accountId, handle: uploaded.handle, secretMaterial: uploaded.secretMaterial });
  } catch (error) {
    tamperError = (error as Error).message;
  }
  log(`TAMPERED CIPHERTEXT: 拒绝=${tamperError !== "(未报错)"} reason="${tamperError.slice(0, 40)}"`);

  // 5) 大小上限
  let oversizeError = "(未报错)";
  try {
    await container.mediaStorage.put({ bytes: new Uint8Array(MEDIA_LIMITS.maxMediaBytes + 1), mimeType: null, filename: null, origin: "generated" });
  } catch (error) {
    oversizeError = (error as Error).message;
  }
  log(`OVERSIZE REJECTED: ${oversizeError.slice(0, 60)}`);

  log(identical ? "PHASE 4.5-B SMOKE OK（二进制完全一致）" : "PHASE 4.5-B SMOKE FAILED（二进制不一致）");
} finally {
  await container.shutdown();
  await weixin.close();
  await cdn.close();
  if (cleanup) rmSync(dataDir, { recursive: true, force: true });
}
