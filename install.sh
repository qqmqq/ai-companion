#!/usr/bin/env bash
#
# AI Companion 一键安装（macOS / Linux / WSL）
#
# 它会做的事：检查 Node 版本 -> 装好 pnpm -> 装依赖 -> 生成 .env（已存在就不动）
#              -> 构建 -> 告诉你怎么启动。
# 它不会做的事：不装系统包、不用 sudo、不覆盖你已有的配置和数据、不删任何文件。
#
# 用法：
#   ./install.sh                 在当前仓库里安装
#   ./install.sh --yes           不提问（适合脚本 / AI 代跑）
#   ./install.sh --check         只检查环境，什么都不改
#   ./install.sh --no-build      跳过构建
#   ./install.sh --dir ~/apps/ai-companion   把仓库克隆到这个目录再安装
#   ./install.sh --start         安装完直接前台启动（Ctrl+C 退出）
#
set -euo pipefail

REPO_URL="https://github.com/qqmqq/ai-companion.git"
REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=13
PNPM_VERSION="10"

ASSUME_YES=0
CHECK_ONLY=0
DO_BUILD=1
DO_START=0
TARGET_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) ASSUME_YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    --no-build) DO_BUILD=0 ;;
    --start) DO_START=1 ;;
    --dir) shift; TARGET_DIR="${1:-}" ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）"; exit 2 ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

say ""
say "AI Companion 安装程序"
say "---------------------"

# 0. 别用 root 跑：后面会在当前目录写文件
if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then
  warn "你现在是 root。本项目不需要 root，建议用普通用户重跑，装出来的文件才归你自己。"
fi

# 1. 进目录（或者先克隆）
if [ -n "$TARGET_DIR" ]; then
  if [ -d "$TARGET_DIR/.git" ]; then
    ok "目标目录已经是一个 git 仓库，直接用它：$TARGET_DIR"
    cd "$TARGET_DIR"
  else
    command -v git >/dev/null 2>&1 || die "找不到 git，请先安装 git（macOS: xcode-select --install；Debian/Ubuntu: sudo apt install git）"
    say "克隆到 $TARGET_DIR …"
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
    cd "$TARGET_DIR"
  fi
fi

[ -f package.json ] || die "当前目录不是项目根目录（没有 package.json）。请进到仓库目录，或用 --dir 指定。"
grep -q '"name": "ai-companion"' package.json || warn "这里的 package.json 看起来不是 ai-companion，继续但请自己确认。"

# 2. Node 版本
command -v node >/dev/null 2>&1 || die "找不到 Node.js。请先装 Node ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR} 或更高（推荐 24.x）：https://nodejs.org/"
NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_REST="${NODE_VERSION#*.}"
NODE_MINOR="${NODE_REST%%.*}"
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$REQUIRED_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$REQUIRED_NODE_MINOR" ]; }; then
  die "Node 版本太低：现在是 v${NODE_VERSION}，需要 >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}（本项目用到原生 TS 类型剥离与 node:sqlite，低版本跑不起来）。"
fi
ok "Node v${NODE_VERSION}"

# 3. pnpm
ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    local pnpm_major
    pnpm_major="$(pnpm --version | cut -d. -f1)"
    if [ "$pnpm_major" -ge "$PNPM_VERSION" ]; then
      ok "pnpm $(pnpm --version)"
      return 0
    fi
    warn "pnpm 版本偏低（$(pnpm --version)），尝试用 corepack 切到 ${PNPM_VERSION}"
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || warn "corepack enable 失败（可能没权限写 Node 目录）"
    if corepack prepare "pnpm@${PNPM_VERSION}" --activate >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
      ok "已用 corepack 启用 pnpm $(pnpm --version)"
      return 0
    fi
    warn "corepack 没能装好 pnpm"
  fi
  if [ "$ASSUME_YES" -eq 1 ]; then
    say "用 npm 全局安装 pnpm@${PNPM_VERSION} …"
  else
    printf '要我用 npm 全局安装 pnpm@%s 吗？[y/N] ' "$PNPM_VERSION"
    read -r answer || answer="n"
    case "$answer" in [yY]*) ;; *) die "没有 pnpm 就装不了。你也可以自己跑：npm i -g pnpm@${PNPM_VERSION}" ;; esac
  fi
  command -v npm >/dev/null 2>&1 || die "连 npm 也找不到，请检查 Node 安装。"
  npm i -g "pnpm@${PNPM_VERSION}" || die "pnpm 安装失败。可以手动试：npm i -g pnpm@${PNPM_VERSION}"
  ok "pnpm $(pnpm --version)"
}
ensure_pnpm

if [ "$CHECK_ONLY" -eq 1 ]; then
  say ""
  ok "环境检查通过（--check 模式，没有改动任何东西）"
  say "接下来：./install.sh"
  exit 0
fi

# 4. 依赖
say ""
say "[1/3] 安装依赖 …"
if [ -f pnpm-lock.yaml ]; then
  pnpm install --frozen-lockfile || { warn "按锁文件安装失败，改成按 package.json 装"; pnpm install; }
else
  pnpm install
fi
ok "依赖装好了"

# 5. 配置（已存在绝不覆盖）
say ""
say "[2/3] 配置 …"
if [ -f .env ]; then
  ok ".env 已存在，保持不动"
elif [ -f .env.example ]; then
  cp .env.example .env
  ok "已按 .env.example 生成 .env（默认只监听本机 127.0.0.1:8787）"
else
  warn "没有 .env.example，跳过（用默认配置也能跑）"
fi

# 6. 构建
if [ "$DO_BUILD" -eq 1 ]; then
  say ""
  say "[3/3] 构建 …"
  pnpm build
  ok "构建完成"
else
  say ""
  ok "按 --no-build 跳过构建"
fi

say ""
say "装好了。启动方式："
say "  pnpm dev          # 同时起后端(8787)与前端(5173)"
say "  然后浏览器打开 http://127.0.0.1:5173"
say ""
say "第一次用建议：模型设置里填一个 OpenAI 兼容服务或 Ollama；不填也能先跑（内置占位模型）。"
say "数据都在本机 backend/data/ 下（SQLite + 媒体 + 主密钥），不会上传到任何地方。"

if [ "$DO_START" -eq 1 ]; then
  say ""
  say "启动中（Ctrl+C 结束）…"
  exec pnpm dev
fi
