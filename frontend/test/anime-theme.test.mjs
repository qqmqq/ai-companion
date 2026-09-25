import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * 配色的可执行约束。
 *
 * 二次元配色最容易翻车的地方是"看起来好看，读起来费劲"：粉字压在粉底上、灰字压在紫底上。
 * 所以这里不检查具体色号，而是把对比度算出来对线 —— 换色可以，掉到线下就红。
 */

const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function token(name) {
  const match = new RegExp("--" + name + ":\\s*([^;]+);").exec(css);
  assert.ok(match, "样式表里应该有令牌 --" + name);
  return match[1].trim();
}
function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}
function hexOf(parts) {
  return "#" + parts.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
/** 半透明色压在底色上之后的实际颜色 */
function over(fgHex, alpha, bgHex) {
  const f = rgb(fgHex);
  const b = rgb(bgHex);
  return hexOf(f.map((v, i) => v * alpha + b[i] * (1 - alpha)));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("正文与次要文字：对面板与背景都在 4.5:1 之上", () => {
  for (const surface of ["panel", "panel-2", "bg"]) {
    const bg = token(surface);
    assert.ok(contrast(token("text"), bg) >= 4.5, "正文压在 --" + surface + " 上要够亮");
    assert.ok(contrast(token("muted"), bg) >= 4.5, "次要文字压在 --" + surface + " 上也要够亮");
  }
});

test("可操作控件：边框对相邻表面至少 3:1，悬停态比静止态更亮", () => {
  const control = token("line-control");
  const strong = token("line-strong");
  for (const surface of ["panel", "bg", "field"]) {
    assert.ok(contrast(control, token(surface)) >= 3, "--line-control 对 --" + surface + " 要 ≥ 3:1");
  }
  assert.ok(contrast(strong, token("panel")) > contrast(control, token("panel")), "悬停态必须比静止态更明显");
});

test("强调色：粉底上的深字、面板上的粉字都要读得清", () => {
  assert.ok(contrast(token("accent-ink"), token("accent")) >= 4.5, "主按钮文字压在樱花粉上要 ≥ 4.5:1");
  assert.ok(contrast(token("accent"), token("panel")) >= 4.5, "作为链接色用的粉字要 ≥ 4.5:1");
  assert.ok(contrast(token("accent-2"), token("panel")) >= 4.5, "天空蓝同理");
});

test("半透明表面：合成之后的实际对比度仍然达标", () => {
  const panel = token("panel");
  const bg = token("bg");
  // 标签：粉底 + 粉字
  const tagBg = over(token("accent"), 0.16, panel);
  assert.ok(contrast(token("accent"), tagBg) >= 4.5, "标签里的粉字要读得清");
  // 自己说的话：蓝底 + 正文
  const userBubble = over(token("accent-2"), 0.18, bg);
  assert.ok(contrast(token("text"), userBubble) >= 4.5, "自己气泡里的正文要读得清");
  // 角色说的话：粉底 + 正文/次要文字
  const characterBubble = over(token("accent"), 0.16, bg);
  assert.ok(contrast(token("text"), characterBubble) >= 4.5, "角色气泡里的正文要读得清");
  assert.ok(contrast(token("muted"), characterBubble) >= 4.5, "角色气泡里的说话人也算正文");
});

test("二次元的味道靠令牌和形状，不靠写死颜色：旧配色不该留在样式表里", () => {
  for (const gone of ["#0e1014", "#161a21", "#7fb0ff", "#5c6675", "#7a8698", "#17202b", "#2a4463"]) {
    assert.equal(css.toLowerCase().includes(gone), false, "旧配色 " + gone + " 应该已经从令牌里清掉");
  }
  assert.match(css, /--accent:\s*#ff8ac7/i, "樱花粉是主强调色");
  assert.match(css, /--accent-2:\s*#7fd7ff/i, "天空蓝是次强调色");
  assert.match(css, /radial-gradient\(1\.6px 1\.6px/, "夜空背景要有星点");
  assert.match(css, /@supports \(background-clip: text\)/, "渐变标题要有兜底");
});

test("装饰归装饰：动效要能被关掉，焦点圈要在", () => {
  assert.match(css, /prefers-reduced-motion: reduce/, "减少动效时不能还在动");
  assert.match(css, /:focus-visible/, "键盘焦点仍然要看得见");
  assert.match(css, /--glow-soft:/, "发光做成令牌，方便统一调");
});
