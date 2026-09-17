import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SRC_ROOT, importSpecifiers, isWithin, listSourceFiles, readSource, relFromSrc, resolveSpecifier } from "../helpers/files.ts";

const PLATFORM_TOKENS = /(weixin|openclaw|telegram|discord|whatsapp)/i;
const CORE_ROOT = join(SRC_ROOT, "core").split("\\").join("/");
const UTIL_ROOT = join(SRC_ROOT, "util").split("\\").join("/");

test("ARCH-1 Core 源码不含任何具体平台字样", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles().filter((f) => isWithin(f.split("\\").join("/"), CORE_ROOT))) {
    const source = readSource(file);
    const line = source.split("\n").findIndex((text) => PLATFORM_TOKENS.test(text));
    if (line >= 0) offenders.push(`${relFromSrc(file)}:${line + 1}`);
  }
  assert.deepEqual(offenders, [], "Core 必须对具体通信平台一无所知");
});

test("ARCH-2 Core 只依赖 core/ 与纯 util/，不 import 任何基础设施实现", () => {
  const offenders: string[] = [];
  const coreFiles = listSourceFiles().filter((f) => isWithin(f.split("\\").join("/"), CORE_ROOT));
  for (const file of coreFiles) {
    for (const specifier of importSpecifiers(readSource(file))) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) {
        offenders.push(`${relFromSrc(file)} -> 外部包 ${specifier}`);
        continue;
      }
      if (!isWithin(resolved, CORE_ROOT) && !isWithin(resolved, UTIL_ROOT)) {
        offenders.push(`${relFromSrc(file)} -> ${resolved.replace(SRC_ROOT.split("\\").join("/"), "src")}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "Core 只能依赖自身与 util/；持久化与渠道必须走端口");
});

test("ARCH-3 只有组合根 bootstrap.ts 可以依赖具体渠道实现", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const rel = relFromSrc(file);
    if (rel.startsWith("channels/") || rel === "app/bootstrap.ts") continue;
    for (const specifier of importSpecifiers(readSource(file))) {
      const resolved = resolveSpecifier(file, specifier);
      if (resolved === null) continue;
      if (resolved.includes("/channels/")) {
        // Web 渠道自己的 API 路由可以用自己的 kind 常量；其他情况一律违规
        if (rel.startsWith("api/routes/conversations.ts") && resolved.endsWith("/channels/web/channel.ts")) continue;
        offenders.push(`${rel} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "具体渠道只能被组合根装配");
});

test("ARCH-4 channels/ 之外不得出现渠道专有标识（以 weixin 为例）", () => {
  const offenders: string[] = [];
  for (const file of listSourceFiles()) {
    const rel = relFromSrc(file);
    if (rel.startsWith("channels/")) continue;
    const source = readSource(file);
    const line = source.split("\n").findIndex((text) => /weixin/i.test(text));
    if (line >= 0) offenders.push(`${rel}:${line + 1}`);
  }
  assert.deepEqual(offenders, [], "渠道专有逻辑必须被关在 channels/<kind>/ 内");
});

test("ARCH-5 依赖清单中不得出现 openclaw 或任何渠道 SDK", () => {
  const manifests = [
    join(SRC_ROOT, "..", "package.json"),
    join(SRC_ROOT, "..", "..", "package.json"),
    join(SRC_ROOT, "..", "..", "frontend", "package.json"),
  ];
  const offenders: string[] = [];
  for (const manifest of manifests) {
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf8")) as typeof parsed;
    } catch {
      continue; // 尚未创建的文件跳过
    }
    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      for (const name of Object.keys(parsed[section] ?? {})) {
        if (/openclaw|weixin|ilink/i.test(name)) offenders.push(`${manifest}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "禁止引入 OpenClaw 或渠道 SDK 依赖");
});

test("ARCH-6 Core 不依赖任何运行时依赖（零外部包）", () => {
  const offenders: string[] = [];
  const coreFiles = listSourceFiles().filter((f) => isWithin(f.split("\\").join("/"), CORE_ROOT));
  for (const file of coreFiles) {
    for (const specifier of importSpecifiers(readSource(file))) {
      if (specifier.startsWith("node:")) continue;
      if (specifier.startsWith(".")) continue;
      offenders.push(`${relFromSrc(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, [], "Core 不得依赖第三方包（含 zod 等）");
});
