import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const SRC_ROOT = join(import.meta.dirname, "..", "..", "src");

export function listSourceFiles(root: string = SRC_ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

export function readSource(file: string): string {
  return readFileSync(file, "utf8");
}

export function relFromSrc(file: string): string {
  return relative(SRC_ROOT, file).split("\\").join("/");
}

/** 提取所有 import / export-from 的模块说明符。 */
export function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[^"'\n]*?from\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^"'\n]*?from\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

export function resolveSpecifier(file: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return resolve(join(file, ".."), specifier).split("\\").join("/");
}

export function isWithin(path: string, parent: string): boolean {
  const normalizedParent = parent.split("\\").join("/");
  return path === normalizedParent || path.startsWith(`${normalizedParent}/`);
}
