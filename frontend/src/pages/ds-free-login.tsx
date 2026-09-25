import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { DsFreeApplyResultDto, DsFreeDiagnosisDto, DsFreeHelperStatusDto } from "../lib/types.ts";

/** 阶段一律说人话：内部枚举只在这张表里出现，表里没有的也绝不给用户看 undefined */
const PHASE_LABELS: Record<DsFreeHelperStatusDto["phase"], string> = {
  idle: "还没开始",
  waiting_login: "已打开登录页，正在自动读取",
  captured: "已拿到所需信息",
  error: "出错了",
};

function phaseLabel(phase: string): string {
  return (PHASE_LABELS as Record<string, string | undefined>)[phase] ?? "状态未知";
}

/** 只在"正在等"的时候轮询，其余时候不打扰后端 */
const POLL_MS = 1500;

export function DsFreeLoginPanel(props: { onError: (message: string) => void; onApplied?: () => void }) {
  const [status, setStatus] = useState<DsFreeHelperStatusDto | null>(null);
  const [email, setEmail] = useState("");
  const [deepseekPassword, setDeepseekPassword] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  /** 已经存过管理密码就不显示这一栏；用户主动点「换一个」才露出来 */
  const [wantNewAdminPassword, setWantNewAdminPassword] = useState(false);
  const [binaryPath, setBinaryPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DsFreeApplyResultDto | null>(null);
  const [diagnosis, setDiagnosis] = useState<DsFreeDiagnosisDto | null>(null);
  const polling = useRef(false);
  /** 已经在「抓完自动加模型」这一步通知过设置页，避免反复刷新 */
  const notified = useRef(false);
  /**
   * 父组件每次渲染都会传新的函数进来：直接把 props 放进依赖会让 refresh 每次都变，
   * 挂载 effect 于是反复触发 → 状态接口被无限轮询。用 ref 记住最新的回调，依赖保持为空。
   */
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;
  const onAppliedRef = useRef(props.onApplied);
  onAppliedRef.current = props.onApplied;

  const refresh = useCallback(async () => {
    try {
      const next = await api.dsFreeStatus();
      setStatus(next);
      return next;
    } catch (error) {
      onErrorRef.current((error as Error).message);
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 抓完会顺手把模型加进「已配置的模型」：让设置页刷新一次，用户马上能看见 */
  useEffect(() => {
    if (status?.providerId === null || status?.providerId === undefined) return;
    if (notified.current) return;
    notified.current = true;
    onAppliedRef.current?.();
  }, [status?.providerId]);

  useEffect(() => {
    if (status?.phase !== "waiting_login") {
      polling.current = false;
      return;
    }
    polling.current = true;
    const timer = window.setInterval(() => {
      if (!polling.current) return;
      void refresh();
    }, POLL_MS);
    return () => {
      polling.current = false;
      window.clearInterval(timer);
    };
  }, [status?.phase, refresh]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setResult(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      onErrorRef.current((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    setBusy(true);
    setResult(null);
    notified.current = false;
    try {
      const next = await api.dsFreeStart(binaryPath.trim().length === 0 ? {} : { binaryPath: binaryPath.trim() });
      setStatus(next);
    } catch (error) {
      onErrorRef.current((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    setBusy(true);
    try {
      const applied = await api.dsFreeApply({
        email: email.trim(),
        deepseekPassword,
        ...(showAdminPasswordField && adminPassword.length > 0 ? { adminPassword } : {}),
      });
      setResult(applied);
      // 密码用完即弃：立刻从界面状态里清掉，不留在输入框里
      setDeepseekPassword("");
      setAdminPassword("");
      await refresh();
      onAppliedRef.current?.();
    } catch (error) {
      onErrorRef.current((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const captured = status?.deviceId !== null && status?.deviceId !== undefined;
  /** 反代管理密码：已经存在本机就不问了（用户点「换一个」才会重新出现） */
  const adminPasswordSaved = status?.adminPasswordSaved === true;
  const showAdminPasswordField = !adminPasswordSaved || wantNewAdminPassword;
  const adminPasswordReady = !showAdminPasswordField || adminPassword.length >= 6;
  const canApply = captured && email.trim().length > 0 && deepseekPassword.length > 0 && adminPasswordReady && !busy;
  /** 反代没起来、也没找到程序时才需要用户告诉我们它在哪 */
  const needsBinaryPath = captured && status?.proxyReachable !== true;

  return (
    <section className="panel">
      <h2>接入助手：打开真实网页，自动获取所需</h2>
      <p className="hint">
        点下面的按钮会打开一个<strong>真实的浏览器窗口</strong>进入 DeepSeek 登录页。页面一加载完，我们就自动读出反代登录必需的设备指纹
        （device_id），然后<strong>自动关掉那个窗口</strong>、<strong>自动把反代跑起来</strong>、并<strong>把模型加进「已配置的模型」</strong>。
      </p>
      <p className="hint">
        反代程序是别人的开源项目
        <a href="https://github.com/NIyueeE/ds-free-api" target="_blank" rel="noreferrer"> ds-free-api </a>
        （GPL-3.0），本项目不打包也不下载它：只在你机器上找到你已经下好的那个可执行文件并替你启动。
      </p>

      <ul className="cards">
        <li>
          <div className="row space-between">
            <strong>当前状态</strong>
            <span className={status?.phase === "captured" ? "ok-text" : status?.phase === "error" ? "warn" : "hint"}>
              {status === null ? "正在读取…" : phaseLabel(status.phase)}
            </span>
          </div>
          <div className="meta">
            <span>设备指纹：{captured ? "已获取" : "还没拿到"}</span>
            <span>浏览器：{status?.browser ?? "—"}</span>
            <span>登录页：{status?.browserClosed === true ? "已自动关闭" : status?.browserClosed === false ? "已不在" : "—"}</span>
          </div>
          <div className="meta">
            <span>
              反代：
              {status === null
                ? "—"
                : status.proxyReachable === true
                  ? status.proxyStarted === true
                    ? "已自动启动"
                    : "在运行"
                  : status.proxyReachable === false
                    ? "没连上"
                    : "未知"}
            </span>
            <span>模型：{status?.providerId ?? "还没加"}</span>
          </div>
          {status !== null && status.proxyNote.length > 0 && <p className={status.proxyReachable === true ? "hint" : "warn"}>{status.proxyNote}</p>}
          {status !== null && status.providerNote.length > 0 && <p className="hint">{status.providerNote}</p>}
          {status !== null && <p className="hint">{status.pageHint}</p>}
          {status?.preparing === true && <p className="hint">正在自动收尾：关掉浏览器窗口 → 启动反代 → 加入模型…</p>}
          {status?.lastError !== null && status?.lastError !== undefined && <p className="warn">{status.lastError}</p>}
        </li>
      </ul>

      <div className="row">
        <button aria-busy={busy} disabled={busy} onClick={() => void handleStart()}>
          {busy ? "处理中…" : captured ? "重新打开登录页并获取" : "打开登录页并自动获取"}
        </button>
        <button className="ghost" disabled={busy || status?.phase !== "waiting_login"} onClick={() => void run(() => api.dsFreeStop())}>
          停止等待
        </button>
        {/* 超时了先看这里：真正的原因写在反代自己的日志里 */}
        <button className="ghost" disabled={busy} onClick={() => void run(() => api.dsFreeDiagnose().then(setDiagnosis))}>
          看看反代怎么了
        </button>
      </div>

      {needsBinaryPath && (
        <label>
          反代程序在哪（找不到才要填，填一次就记住）
          <input
            value={binaryPath}
            onChange={(event) => setBinaryPath(event.target.value)}
            placeholder="例如 D:\ds-free-api\ds-free-api.exe"
          />
        </label>
      )}

      <div className="grid">
        <label>
          DeepSeek 账号（邮箱或手机号）
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="登录邮箱，或 11 位手机号" autoComplete="off" />
        </label>
        <label>
          DeepSeek 密码
          <input
            type="password"
            value={deepseekPassword}
            onChange={(event) => setDeepseekPassword(event.target.value)}
            placeholder="只用于这一次写入，不会保存"
            autoComplete="off"
          />
        </label>
        {showAdminPasswordField && (
          <label>
            反代管理密码
            <input
              type="password"
              value={adminPassword}
              onChange={(event) => setAdminPassword(event.target.value)}
              placeholder="ds-free-api 管理面板的密码（首次会自动设上）"
              autoComplete="off"
            />
          </label>
        )}
      </div>
      <button aria-busy={busy && canApply} disabled={!canApply} onClick={() => void handleApply()}>
        {busy ? "正在写入…" : "一键写入并配好 provider"}
      </button>
      {!captured && <p className="hint">先点上面的按钮拿到设备指纹，这里的写入才会生效。</p>}
      {captured && !showAdminPasswordField && (
        <p className="hint">
          反代管理密码已经记在本机加密库里了，这里不用再填。
          <button className="ghost" onClick={() => setWantNewAdminPassword(true)}>
            换一个管理密码
          </button>
        </p>
      )}

      {diagnosis !== null && (
        <div>
          <p className={diagnosis.ok ? "hint" : "warn"}>{diagnosis.summary}</p>
          {diagnosis.lines.length > 0 && (
            <ul className="hint">
              {diagnosis.lines.map((line, index) => (
                <li key={index}>
                  <code>{line}</code>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">日志：{diagnosis.logPath}（长数字已打码）</p>
        </div>
      )}

      {result !== null && (
        <div>
          <p className="ok-text">
            已配好：{result.providerId}（密钥 {result.apiKeyMasked}）。接下来去「任务用哪个模型」把要用的任务指到它。
          </p>
          {/* 当场验过才敢说可用：账号密码不对 / 账号池空 都会在这里露出来 */}
          <p className={result.verify.ok ? "ok-text" : "warn"}>
            {result.verify.ok
              ? "已实测一次真实请求：通，现在可以用了。"
              : "已实测一次真实请求：不通 —— " + result.verify.reason + "（多半是账号/密码不对，或这个账号还没在 DeepSeek 网页端登录过）"}
          </p>
          <ul className="hint">
            {result.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="hint">
        密码只在你点「一键写入」的那一次请求里使用，不落库、不进日志，界面与接口只回掩码。密码不对、反代没开这类问题都会当场如实告诉你。
      </p>
    </section>
  );
}
