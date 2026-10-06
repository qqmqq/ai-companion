#!/usr/bin/env node
/**
 * 公开仓库的个人信息扫描。
 *
 * 为什么需要它：这个项目本来是给自己用的，里面很容易顺手写下"我的路径""我那个角色叫什么"，
 * 一旦仓库转成公开，这些东西就跟着公开了。人工检查会漏，所以把规则写成脚本，
 * 顺手挂进 CI —— 以后谁再把本机路径带进来，CI 当场红。
 *
 * 用法：node scripts/pii-scan.mjs [--json]
 * 退出码：0 = 干净，1 = 有发现。行内写 `pii-scan: allow` 可以豁免单行（用于测试夹具）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const asJson = process.argv.includes("--json");
const explicitFiles = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
/** 扫描器自己当然写着这些规则，把自己排除掉，免得自检自爆 */
const SELF = "scripts/pii-scan.mjs";
/** 路径里这些用户名是通用占位符（或 CI 账号），不算个人信息 */
const PLACEHOLDER_USERS = new Set([
  "me", "user", "username", "test", "example", "you", "someone", "abc",
  // CI 和服务账号：GitHub Actions 的用户名就叫 runner，ubuntu 镜像里常见 vscode/node 之类，
  // 这些名字出现在代码里（例如 scheduler-runner.ts）毫无个人信息可言。
  "runner", "root", "admin", "administrator", "builder", "ubuntu", "vscode", "node", "ci", "github", "actions", "host",
]);
/**
 * 测试夹具里的假值：这些是编出来的，不该逼着大家在几十行上写豁免注释。
 * 判断依据是"一眼假"——同一数字重复、连续递增、或含 test/secret/dummy 这类词。
 */
const FAKE_PHONES = new Set(["13800138000", "13900139000", "13333332977", "18888888888", "17777777777"]);
const looksFakePhone = (value) => FAKE_PHONES.has(value) || new Set(value.slice(1)).size <= 2 || /^(\d)\1{6,}$/.test(value);
const FAKE_SECRET_WORDS = /(secret|smoke|test|example|dummy|fake|placeholder|redact|sample|abcdef|xxxx|123456)/i;
const FAKE_MAIL_DOMAINS = /(@im\.bot$|@example\.|@test$|@invalid$|@localhost$|\.local$)/i;
const FAKE_MAIL_LOCAL = /^(test|keep-me|acct|user|example|demo)/i;
const BINARY = /\.(png|jpe?g|webp|gif|ico|woff2?|ttf|otf|db|db-wal|db-shm|zip|gz|wasm|pdf)$/i;

const rules = [
  {
    id: "home-path",
    // 本机绝对路径：C:\Users\xxx\ 或 /Users/xxx/ 或 /home/xxx/
    // pii-scan: allow
    pattern: /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g,
    message: "本机绝对路径（带用户名）",
    filter: (match) => !PLACEHOLDER_USERS.has(String(match[1]).toLowerCase()),
  },
  {
    id: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    message: "邮箱地址",
    filter: (match) => !FAKE_MAIL_DOMAINS.test(match[0]) && !FAKE_MAIL_LOCAL.test(match[0]),
  },
  {
    id: "cn-mobile",
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    message: "看起来像手机号",
    filter: (match) => !looksFakePhone(match[0]),
  },
  {
    id: "private-key",
    pattern: /-----BEGIN[^-]*PRIVATE KEY-----/g,
    message: "私钥内容",
    filter: () => true,
  },
  {
    id: "token",
    pattern: /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{12,})/g,
    message: "疑似访问令牌 / API Key",
    filter: (match) => !FAKE_SECRET_WORDS.test(match[0]),
  },
  {
    id: "sensitive-file",
    message: "不该进版本库的文件",
    fileOnly: true,
    filter: (match, file) => {
      const base = file.split("/").pop() ?? "";
      if (file.endsWith(".env.example")) return false;
      return (
        base === ".env" ||
        /^data\//.test(file) ||
        /\.(pem|key|p12|pfx)$/i.test(file) ||
        /\.(db|db-wal|db-shm)$/i.test(file) ||
        /(^|\/)id_(rsa|ed25519)$/.test(file)
      );
    },
  },
];

/** 不给参数就扫版本库里的全部文件；给了路径就只扫这些（自检 / 扫描外部文件用） */
function trackedFiles() {
  if (explicitFiles.length > 0) return explicitFiles;
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  return out.toString("utf8").split("\0").filter(Boolean);
}

const findings = [];
for (const file of trackedFiles()) {
  if (file === SELF) continue;
  for (const rule of rules) {
    if (rule.fileOnly) {
      if (rule.filter(null, file)) findings.push({ rule: rule.id, file, line: 0, text: rule.message, match: file });
      continue;
    }
    if (!rule.pattern) continue;
    if (BINARY.test(file)) break;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      break;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.includes("pii-scan: allow")) continue;
      rule.pattern.lastIndex = 0;
      let match;
      while ((match = rule.pattern.exec(line)) !== null) {
        if (rule.filter(match, file)) {
          findings.push({ rule: rule.id, file, line: index + 1, text: rule.message, match: match[0] });
        }
        if (match[0] === "") break;
      }
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
} else if (findings.length === 0) {
  console.log("[pii-scan] 通过：版本库里没有发现本机路径 / 邮箱 / 手机号 / 密钥 / 令牌 / 敏感文件。");
} else {
  console.log("[pii-scan] 发现 " + findings.length + " 处需要处理：");
  for (const item of findings) {
    console.log("  - " + item.file + (item.line ? ":" + item.line : "") + "  [" + item.rule + "] " + item.text + " -> " + item.match);
  }
  console.log("\n处理办法：删掉 / 改成占位符 / 加进 .gitignore 后 git rm --cached；确属测试夹具可在该行写 pii-scan: allow。");
}
process.exit(findings.length === 0 ? 0 : 1);
