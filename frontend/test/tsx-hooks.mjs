// 让 node --test 能直接跑 .tsx（JSX 由 esbuild 转换，Node 自身的类型剥离不支持 JSX）
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && (url.endsWith(".tsx") || url.endsWith(".ts"))) {
    const source = await readFile(fileURLToPath(url), "utf8");
    const result = await transform(source, {
      loader: url.endsWith(".tsx") ? "tsx" : "ts",
      format: "esm",
      target: "es2022",
      jsx: "automatic",
      sourcefile: fileURLToPath(url),
    });
    return { format: "module", source: result.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
