import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * 主题的可执行约束（换皮不换规矩）。
 *
 * 这套界面每隔一阵就会换一次风格，最容易翻车的地方永远是同一个：
 * 好看的颜色配到一起，字就读不清了（白卡上的浅灰、荧光底上的绿字）。
 * 所以这里不检查具体色号，只把样式表里的令牌**算成对比度**再卡门槛 ——
 * 换色随便换，掉到线下就红。
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
function hex(value) {
  assert.match(value, /^#[0-9a-f]{6}$/i, "这个断言只认十六进制：" + value);
  return value;
}

test("正文与次要文字：压在任何一层表面上都要 ≥ 4.5:1", () => {
  for (const surface of ["panel", "panel-2", "bg", "field"]) {
    assert.ok(contrast(hex(token("text")), hex(token(surface))) >= 4.5, "正文压在 --" + surface + " 上");
    assert.ok(contrast(hex(token("muted")), hex(token(surface))) >= 4.5, "次要文字压在 --" + surface + " 上");
  }
});

test("白卡上的字：正文、次要文字、错误提示都要 ≥ 4.5:1", () => {
  const paper = hex(token("paper"));
  assert.ok(contrast(hex(token("ink")), paper) >= 4.5, "白卡正文");
  assert.ok(contrast(hex(token("muted-ink")), paper) >= 4.5, "白卡上的说话人/提示");
  assert.ok(contrast(hex(token("danger-ink")), paper) >= 4.5, "白卡上的错误文字");
});

test("荧光底上的字：黑字要压在强调色上读得清", () => {
  assert.ok(contrast(hex(token("accent-ink")), hex(token("accent"))) >= 4.5, "主按钮/自己气泡里的字");
});

test("可操作控件：边框对相邻表面 ≥ 3:1，悬停态必须比静止态更亮", () => {
  const control = hex(token("line-control"));
  const strong = hex(token("line-strong"));
  for (const surface of ["panel", "bg", "field"]) {
    assert.ok(contrast(control, hex(token(surface))) >= 3, "--line-control 对 --" + surface);
  }
  assert.ok(contrast(strong, hex(token("panel"))) > contrast(control, hex(token("panel"))), "悬停要比静止明显");
});

test("强调色本身当文字用时也要够亮", () => {
  assert.ok(contrast(hex(token("accent")), hex(token("panel"))) >= 4.5, "荧光绿当链接色");
  assert.ok(contrast(hex(token("accent-2")), hex(token("panel"))) >= 4.5, "洋红当链接色");
});
test("风格是「方角 + 硬边投影」：圆角令牌要小到看得见直角，投影不能是模糊的", () => {
  for (const name of ["r-sm", "r-md"]) {
    const size = Number(token(name).replace("px", ""));
    assert.ok(size <= 6, "--" + name + " 应该接近直角，现在是 " + size + "px");
  }
  const hard = token("shadow-hard");
  assert.match(hard, /\d+px \d+px 0 /, "硬边投影的第三个值必须是 0（不模糊）：" + hard);
  assert.match(css, /var\(--hazard\)/, "45 度警戒条纹是这套界面的记号，不能丢");
});

test("换皮要换干净：旧主题的色号不该留在样式表里", () => {
  const gone = ["#0e1014", "#161a21", "#7fb0ff", "#5c6675", "#7a8698", "#ff8ac7", "#7fd7ff", "#b0a8cf", "#17132a", "#6b6390", "#8d85b8"];
  for (const stale of gone) {
    assert.equal(css.toLowerCase().includes(stale), false, "旧配色 " + stale + " 还留在样式表里");
  }
});

test("无障碍的三件套不能因为换皮被删掉", () => {
  assert.match(css, /prefers-reduced-motion: reduce/, "减少动效时要真的停");
  assert.match(css, /:focus-visible/, "键盘焦点要看得见");
  assert.match(css, /\.visually-hidden/, "读屏专用文字的工具类");
});
