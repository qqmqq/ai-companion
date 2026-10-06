# AI Companion 一键安装（Windows / PowerShell）
#
# 它会做的事：检查 Node 版本 -> 装好 pnpm -> 装依赖 -> 生成 .env（已存在就不动）
#              -> 构建 -> 告诉你怎么启动。
# 它不会做的事：不装系统包、不需要管理员权限、不覆盖你已有的配置和数据、不删任何文件。
#
# 用法：
#   .\install.ps1                    在当前仓库里安装
#   .\install.ps1 -Yes               不提问（适合脚本 / AI 代跑）
#   .\install.ps1 -Check             只检查环境，什么都不改
#   .\install.ps1 -NoBuild           跳过构建
#   .\install.ps1 -Dir C:\apps\ai-companion   把仓库克隆到这个目录再安装
#   .\install.ps1 -Start             安装完直接前台启动（Ctrl+C 退出）
#
# 如果提示"无法加载文件，因为在此系统上禁止运行脚本"，用这一行绕过（只对本次有效）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Check,
  [switch]$NoBuild,
  [switch]$Start,
  [string]$Dir
)

$ErrorActionPreference = "Stop"
$RepoUrl = "https://github.com/qqmqq/ai-companion.git"
$RequiredNodeMajor = 22
$RequiredNodeMinor = 13
$PnpmVersion = "10"

function Say  { param([string]$Text) Write-Host $Text }
function Ok   { param([string]$Text) Write-Host "  [OK] $Text" -ForegroundColor Green }
function Warn { param([string]$Text) Write-Host "  [!!] $Text" -ForegroundColor Yellow }
function Die  { param([string]$Text) Write-Host "  [XX] $Text" -ForegroundColor Red; exit 1 }

Say ""
Say "AI Companion 安装程序"
Say "---------------------"

# 1. 进目录（或者先克隆）
if ($Dir) {
  if (Test-Path (Join-Path $Dir ".git")) {
    Ok "目标目录已经是一个 git 仓库，直接用它：$Dir"
    Set-Location $Dir
  } else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
      Die "找不到 git，请先安装 Git for Windows：https://git-scm.com/download/win"
    }
    Say "克隆到 $Dir ..."
    git clone --depth 1 $RepoUrl $Dir
    if ($LASTEXITCODE -ne 0) { Die "克隆失败，请检查网络或换个目录" }
    Set-Location $Dir
  }
}

if (-not (Test-Path "package.json")) { Die "当前目录不是项目根目录（没有 package.json）。请进到仓库目录，或用 -Dir 指定。" }
if ((Get-Content "package.json" -Raw) -notmatch '"name": "ai-companion"') {
  Warn "这里的 package.json 看起来不是 ai-companion，继续但请自己确认。"
}

# 2. Node 版本
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "找不到 Node.js。请先装 Node $RequiredNodeMajor.$RequiredNodeMinor 或更高（推荐 24.x）：https://nodejs.org/"
}
$nodeVersion = (node -v).TrimStart("v")
$parts = $nodeVersion.Split(".")
$nodeMajor = [int]$parts[0]
$nodeMinor = [int]$parts[1]
if ($nodeMajor -lt $RequiredNodeMajor -or ($nodeMajor -eq $RequiredNodeMajor -and $nodeMinor -lt $RequiredNodeMinor)) {
  Die "Node 版本太低：现在是 v$nodeVersion，需要 >= $RequiredNodeMajor.$RequiredNodeMinor（本项目用到原生 TS 类型剥离与 node:sqlite，低版本跑不起来）。"
}
Ok "Node v$nodeVersion"

# 3. pnpm
function Ensure-Pnpm {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) {
    $pnpmMajor = [int]((pnpm --version) -split "\.")[0]
    if ($pnpmMajor -ge [int]$PnpmVersion) { Ok "pnpm $(pnpm --version)"; return }
    Warn "pnpm 版本偏低（$(pnpm --version)），尝试用 corepack 切到 $PnpmVersion"
  }
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    try { corepack enable 2>$null | Out-Null } catch { Warn "corepack enable 失败（可能没权限写 Node 目录）" }
    try {
      corepack prepare "pnpm@$PnpmVersion" --activate 2>$null | Out-Null
      if (Get-Command pnpm -ErrorAction SilentlyContinue) { Ok "已用 corepack 启用 pnpm $(pnpm --version)"; return }
    } catch { }
    Warn "corepack 没能装好 pnpm"
  }
  if (-not $Yes) {
    $answer = Read-Host "要我用 npm 全局安装 pnpm@$PnpmVersion 吗？[y/N]"
    if ($answer -notmatch "^[yY]") { Die "没有 pnpm 就装不了。你也可以自己跑：npm i -g pnpm@$PnpmVersion" }
  } else {
    Say "用 npm 全局安装 pnpm@$PnpmVersion ..."
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Die "连 npm 也找不到，请检查 Node 安装。" }
  npm i -g "pnpm@$PnpmVersion"
  if ($LASTEXITCODE -ne 0) { Die "pnpm 安装失败。可以手动试：npm i -g pnpm@$PnpmVersion" }
  Ok "pnpm $(pnpm --version)"
}
Ensure-Pnpm

if ($Check) {
  Say ""
  Ok "环境检查通过（-Check 模式，没有改动任何东西）"
  Say "接下来：.\install.ps1"
  exit 0
}

# 4. 依赖
Say ""
Say "[1/3] 安装依赖 ..."
if (Test-Path "pnpm-lock.yaml") {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Warn "按锁文件安装失败，改成按 package.json 装"; pnpm install }
} else {
  pnpm install
}
if ($LASTEXITCODE -ne 0) { Die "依赖安装失败，把上面的报错发出来即可定位" }
Ok "依赖装好了"

# 5. 配置（已存在绝不覆盖）
Say ""
Say "[2/3] 配置 ..."
if (Test-Path ".env") {
  Ok ".env 已存在，保持不动"
} elseif (Test-Path ".env.example") {
  Copy-Item ".env.example" ".env"
  Ok "已按 .env.example 生成 .env（默认只监听本机 127.0.0.1:8787）"
} else {
  Warn "没有 .env.example，跳过（用默认配置也能跑）"
}

# 6. 构建
if (-not $NoBuild) {
  Say ""
  Say "[3/3] 构建 ..."
  pnpm build
  if ($LASTEXITCODE -ne 0) { Die "构建失败，把上面的报错发出来即可定位" }
  Ok "构建完成"
} else {
  Say ""
  Ok "按 -NoBuild 跳过构建"
}

Say ""
Say "装好了。启动方式："
Say "  pnpm dev          # 同时起后端(8787)与前端(5173)"
Say "  然后浏览器打开 http://127.0.0.1:5173"
Say ""
Say "第一次用建议：模型设置里填一个 OpenAI 兼容服务或 Ollama；不填也能先跑（内置占位模型）。"
Say "数据都在本机 backend\data\ 下（SQLite + 媒体 + 主密钥），不会上传到任何地方。"

if ($Start) {
  Say ""
  Say "启动中（Ctrl+C 结束）..."
  pnpm dev
}
