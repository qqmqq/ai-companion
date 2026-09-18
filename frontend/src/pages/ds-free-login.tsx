import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { DsFreeApplyResultDto, DsFreeHelperStatusDto } from "../lib/types.ts";

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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DsFreeApplyResultDto | null>(null);
  /** 浏览器窗口是外部进程，抓到了就停轮询；再点开始才会重启一轮 */
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.dsFreeStatus();
      setStatus(next);
      return next;
    } catch (error) {
      props.onError((error as Error).message);
      return null;
    }
  }, [props]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    setBusy(true);
    setResult(null);
    try {
      const next = await api.dsFreeStart();
      setStatus(next);
    } catch (error) {
      props.onError((error as Error).message);
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
        adminPassword,
      });
      setResult(applied);
      // 密码用完即弃：立刻从界面状态里清掉，不留在输入框里
      setDeepseekPassword("");
      setAdminPassword("");
      await refresh();
      props.onApplied?.();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const captured = status?.deviceId !== null && status?.deviceId !== undefined;
  const canApply =
    captured && email.trim().length > 0 && deepseekPassword.length > 0 && adminPassword.length >= 6 && !busy;

  return (
    <section className="panel">
      <h2>接入助手：打开真实网页，自动获取所需</h2>
      <p className="hint">
        点下面的按钮会打开一个<strong>真实的浏览器窗口</strong>，进入 DeepSeek 登录页。你在那个窗口里正常登录一次，我们会自动读取反代登录必需的设备指纹
        （device_id）。随后填好账号与反代管理密码点「一键写入」，DeepSeek 账号、API Key、这边的 provider 会一次配好。
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
            <span>反代：{status === null ? "—" : status.proxyReachable === true ? "在运行" : status.proxyReachable === false ? "没连上" : "未知"}</span>
          </div>
          {status !== null && <p className="hint">{status.pageHint}</p>}
          {status?.lastError !== null && status?.lastError !== undefined && <p className="warn">{status.lastError}</p>}
        </li>
      </ul>

      <div className="row">
        <button disabled={busy} onClick={() => void handleStart()}>
          {busy ? "处理中…" : captured ? "重新打开登录页并获取" : "打开登录页并自动获取"}
        </button>
        <button className="ghost" disabled={busy || status?.phase !== "waiting_login"} onClick={() => void run(() => api.dsFreeStop())}>
          停止等待
        </button>
      </div>

      <div className="grid">
        <label>
          DeepSeek 账号（邮箱）
          <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="你的 DeepSeek 登录邮箱" autoComplete="off" />
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
      </div>
      <button disabled={!canApply} onClick={() => void handleApply()}>
        {busy ? "正在写入…" : "一键写入并配好 provider"}
      </button>
      {!captured && <p className="hint">先点上面的按钮拿到设备指纹，这里的写入才会生效。</p>}

      {result !== null && (
        <div>
          <p className="ok-text">
            已配好：{result.providerId}（密钥 {result.apiKeyMasked}）。接下来去「任务用哪个模型」把要用的任务指到它。
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
