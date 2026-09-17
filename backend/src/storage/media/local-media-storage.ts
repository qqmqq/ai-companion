import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MediaAsset, MediaPutInput, MediaReadResult, MediaStorage } from "../../core/ports/media-storage.ts";
import type { MediaOrigin } from "../../core/model/media.ts";
import { MEDIA_LIMITS, isWithinMediaSizeLimit, sanitizeFilename } from "../../core/model/media.ts";
import type { Logger } from "../../core/ports/logger.ts";
import type { Clock } from "../../core/ports/clock.ts";
import { DomainError } from "../../core/model/errors.ts";

/** mediaId 只允许我们自己生成的十六进制形式，从根上排除路径穿越。 */
const MEDIA_ID_PATTERN = /^[0-9a-f]{32}$/;

interface MediaSidecar {
  mediaId: string;
  mimeType: string | null;
  filename: string | null;
  sizeBytes: number;
  checksum: string;
  origin: MediaOrigin;
  createdAt: string;
}

export interface LocalMediaStorageDeps {
  dataDir: string;
  logger: Logger;
  clock: Clock;
  maxBytes?: number;
}

/**
 * 文件系统媒体存储：把二进制落在数据目录下，消息里只留 mediaId。
 *
 * - 写入使用临时文件 + rename（原子替换），避免半截文件被当成完整媒体；
 * - 元数据放在同名 sidecar JSON，尺寸/类型都有上限；
 * - 日志只记 id 与尺寸，**永远不记内容**。
 */
export function createLocalMediaStorage(deps: LocalMediaStorageDeps): MediaStorage {
  const root = join(deps.dataDir, "media");
  const maxBytes = deps.maxBytes ?? MEDIA_LIMITS.maxMediaBytes;

  /**
   * 写路径：非法 id 直接报错（调用方有 bug，必须暴露）。
   * 读路径见 tryPathsFor：外部传进来的 id 只要非法就当"不存在"，不抛异常也不碰文件系统。
   */
  function pathsFor(mediaId: string): { bytes: string; meta: string } {
    const paths = tryPathsFor(mediaId);
    if (paths === null) throw new DomainError("invalid_input", "媒体 id 格式非法");
    return paths;
  }

  function tryPathsFor(mediaId: string): { bytes: string; meta: string } | null {
    if (typeof mediaId !== "string" || !MEDIA_ID_PATTERN.test(mediaId)) return null;
    const shard = mediaId.slice(0, 2);
    return { bytes: join(root, shard, `${mediaId}.bin`), meta: join(root, shard, `${mediaId}.json`) };
  }

  async function readSidecar(mediaId: string): Promise<MediaAsset | null> {
    const paths = tryPathsFor(mediaId);
    if (paths === null) return null;
    const { meta } = paths;
    try {
      const raw = await readFile(meta, "utf8");
      if (raw.length > MEDIA_LIMITS.maxMediaMetadataBytes) return null;
      const parsed = JSON.parse(raw) as MediaSidecar;
      return {
        mediaId: parsed.mediaId,
        mimeType: parsed.mimeType,
        filename: parsed.filename,
        sizeBytes: parsed.sizeBytes,
        checksum: parsed.checksum,
        origin: parsed.origin,
        createdAt: parsed.createdAt,
      };
    } catch {
      return null;
    }
  }

  return {
    kind: "local-filesystem",

    async put(input: MediaPutInput): Promise<MediaAsset> {
      const bytes = Buffer.from(input.bytes);
      if (!isWithinMediaSizeLimit(bytes.length, maxBytes)) {
        throw new DomainError("invalid_input", `媒体超过大小上限（${bytes.length} > ${maxBytes} 字节）`);
      }
      const mediaId = randomBytes(16).toString("hex");
      const { bytes: bytesPath, meta: metaPath } = pathsFor(mediaId);
      await mkdir(dirname(bytesPath), { recursive: true, mode: 0o700 });

      /**
       * Phase 4.5-E：**存储边界自己**净化文件名，而不是依赖每个调用方都记得净化。
       * 路径本身只由 mediaId 决定（文件名从不参与路径），但入口不净化会让
       * "../../etc/passwd" 这类值原样写进 sidecar（纵深防御缺口）。
       *
       * MIME 故意**不**在这里净化：既有契约是"存储按调用方给的元数据落盘、
       * 由出站边界负责校验并显式拒绝非法值"（C2/C3 的测试锁定了这个行为）。
       * Core 的 sanitizeMediaReference 在进入消息模型时也会再净化一次。
       */
      const sidecar: MediaSidecar = {
        mediaId,
        mimeType: input.mimeType,
        filename: sanitizeFilename(input.filename),
        sizeBytes: bytes.length,
        checksum: createHash("sha256").update(bytes).digest("hex"),
        origin: input.origin,
        createdAt: deps.clock.nowIso(),
      };

      // 原子写：先写临时文件再 rename，避免读到半截内容
      const tmpBytes = `${bytesPath}.tmp-${randomBytes(4).toString("hex")}`;
      const tmpMeta = `${metaPath}.tmp-${randomBytes(4).toString("hex")}`;
      await writeFile(tmpBytes, bytes, { mode: 0o600 });
      await rename(tmpBytes, bytesPath);
      await writeFile(tmpMeta, JSON.stringify(sidecar), { mode: 0o600 });
      await rename(tmpMeta, metaPath);

      deps.logger.debug("media stored", { mediaId, sizeBytes: bytes.length, mimeType: sidecar.mimeType });
      return { ...sidecar };
    },

    async get(mediaId: string): Promise<MediaReadResult | null> {
      const asset = await readSidecar(mediaId);
      const paths = tryPathsFor(mediaId);
      if (asset === null || paths === null) return null;
      const { bytes: bytesPath } = paths;
      try {
        const info = await stat(bytesPath);
        if (!isWithinMediaSizeLimit(info.size, maxBytes)) return null;
        const bytes = await readFile(bytesPath);
        /**
         * Phase 4.5-E：校验 sidecar 里记录的 sha256。
         * 之前只在写入时算 checksum，读取时从不校验 —— 截断/被改动的文件会被当成正常媒体
         * 一路送进语音/图片处理。校验失败按"不存在"处理（调用方已有既定的 missing 语义），
         * 并且只记录 mediaId 与尺寸这类安全元数据，不记录任何内容。
         */
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== asset.checksum) {
          deps.logger.warn("media checksum mismatch; treating as missing", {
            mediaId,
            sizeBytes: bytes.length,
            expected: asset.checksum.slice(0, 12),
            actual: checksum.slice(0, 12),
          });
          return null;
        }
        return { ...asset, bytes: new Uint8Array(bytes) };
      } catch {
        return null;
      }
    },

    stat: readSidecar,

    async has(mediaId: string): Promise<boolean> {
      return (await readSidecar(mediaId)) !== null;
    },

    async remove(mediaId: string): Promise<boolean> {
      const { bytes: bytesPath, meta: metaPath } = pathsFor(mediaId);
      const existed = (await readSidecar(mediaId)) !== null;
      await rm(bytesPath, { force: true });
      await rm(metaPath, { force: true });
      if (existed) deps.logger.debug("media removed", { mediaId });
      return existed;
    },
  };
}