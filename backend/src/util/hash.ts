/**
 * 纯 JS 的稳定哈希（Phase 4.5-D4）。
 *
 * 为什么不用 node:crypto：Core 必须保持"零第三方依赖 + 只依赖 core/util"（ARCH-2/ARCH-6），
 * 而 node: 内置模块在架构守卫里同样算外部依赖。缓存键只需要**确定性 + 低碰撞**，
 * 不需要密码学强度，因此这里用两个独立基底的 FNV-1a 组合成 64 位十六进制。
 *
 * 碰撞风险由调用方兜底：TTS 缓存键里还包含文本长度，且命中缓存时会再校验长度。
 */

const FNV_OFFSET_A = 0x811c9dc5;
const FNV_PRIME_A = 0x01000193;
const FNV_OFFSET_B = 0x9e3779b9;
const FNV_PRIME_B = 0x85ebca6b;

function fnv1a32(value: string, offset: number, prime: number): number {
  let hash = offset >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // 32 位乘法用 Math.imul，避免精度丢失
    hash = Math.imul(hash, prime) >>> 0;
  }
  return hash >>> 0;
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** 64 位十六进制摘要：确定性、纯 JS、无依赖 */
export function stableHash64(value: string): string {
  const a = fnv1a32(value, FNV_OFFSET_A, FNV_PRIME_A);
  const b = fnv1a32(value, FNV_OFFSET_B, FNV_PRIME_B);
  return hex8(a) + hex8(b);
}
