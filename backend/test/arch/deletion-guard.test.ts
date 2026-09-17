import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { SRC_ROOT } from "../helpers/files.ts";

const BACKEND_ROOT = join(SRC_ROOT, "..");
const TSC = join(BACKEND_ROOT, "node_modules", "typescript", "bin", "tsc");

/**
 * 架构硬守卫（等价于"删掉 channels/weixin/ 之后仍然能构建、测试"）：
 * 把 src 完整复制到临时目录，物理删除 channels/weixin（当前不存在则为 no-op），
 * 然后用同一个 tsconfig 语义对该副本执行真实 tsc 类型检查。
 * Phase 4 加入微信渠道后，这个测试会自动化地证明删除它不会破坏 Core 与 Web 渠道。
 */
function typecheckWithoutWeixin(): { ok: boolean; output: string } {
  const tempRoot = mkdtempSync(join(BACKEND_ROOT, ".guard-"));
  const tempSrc = join(tempRoot, "src");
  cpSync(SRC_ROOT, tempSrc, { recursive: true });

  const removed: string[] = [];
  const weixinDir = join(tempSrc, "channels", "weixin");
  if (existsSync(weixinDir)) {
    rmSync(weixinDir, { recursive: true, force: true });
    removed.push("src/channels/weixin");
  }

  writeFileSync(
    join(tempRoot, "tsconfig.guard.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          allowImportingTsExtensions: true,
          skipLibCheck: true,
          types: ["node"],
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
  );

  let ok = true;
  let output = "";
  try {
    output = execFileSync(process.execPath, [TSC, "-p", join(tempRoot, "tsconfig.guard.json")], {
      cwd: tempRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    ok = false;
    const details = error as { stdout?: string; stderr?: string };
    output = `${details.stdout ?? ""}${details.stderr ?? ""}`;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return { ok, output: `removed=${removed.join(",") || "(none)"}\n${output}` };
}

test("ARCH-7 删除 channels/weixin 后整个 src 仍能通过类型检查（构建不破）", () => {
  const result = typecheckWithoutWeixin();
  assert.ok(result.ok, `删除渠道后类型检查失败:\n${result.output}`);
});

test("ARCH-8 每个渠道目录都是可发现模块或被组合根显式注册", async () => {
  const channelsDir = join(SRC_ROOT, "channels");
  const dirs = readdirSync(channelsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bootstrapSource = readFileSync(join(SRC_ROOT, "app", "bootstrap.ts"), "utf8");

  assert.ok(dirs.includes("web"), "内置 Web 渠道必须存在");

  for (const dir of dirs) {
    const indexPath = join(channelsDir, dir, "index.ts");
    if (existsSync(indexPath)) {
      // 可选渠道：必须真的能被组合根的发现机制加载（不是"文件在但没人用"）
      const loaded = (await import(pathToFileURL(indexPath).href)) as { kind?: unknown; createChannel?: unknown; channelModule?: unknown };
      assert.equal(typeof loaded.kind, "string", `${dir} 模块必须导出 kind`);
      assert.equal(typeof loaded.createChannel, "function", `${dir} 模块必须导出 createChannel`);
      continue;
    }
    // 没有 index.ts 的目录必须是组合根显式注册的渠道（例如内置 web）
    assert.ok(
      bootstrapSource.includes(`${dir}/`),
      `${dir} 既不是可发现模块，也没有被 bootstrap 显式注册`,
    );
  }
});