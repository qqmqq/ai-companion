import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { QqStatusDto } from "../lib/types.ts";

/** 连接状态一律说人话：内部枚举只在这张表里出现 */
const STATE_LABELS: Record<QqStatusDto["session"]["state"], string> = {
  not_configured: "还没配置",
  disconnected: "未连接",
  connecting: "正在连接",
  connected: "已连接",
  reconnecting: "正在重连",
  credential_invalid: "凭证无效，需要重新填",
  stopped: "已停止",
};

export function QqPage(props: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<QqStatusDto | null>(null);
  const [appId, setAppId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [sandbox, setSandbox] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const next = await api.qqStatus();
      setStatus(next);
      if (next.appId !== null) setAppId((current) => (current.length === 0 ? next.appId ?? "" : current));
      if (next.sandbox !== null) setSandbox((current) => current || next.sandbox === true);
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setNote(null);
    try {
      await action();
      await refresh();
      setNote(message);
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>QQ 机器人</h2>
      <p className="hint">
        在 <a href="https://q.qq.com/" target="_blank" rel="noreferrer">QQ 开放平台</a> 建好机器人后，把 <strong>AppID</strong> 与
        <strong>ClientSecret</strong> 填在这里。当前支持<strong>私聊</strong>与<strong>群聊里 @机器人</strong>的文字消息；图片/语音/按钮还没接。
      </p>

      {status !== null && (
        <ul className="cards">
          <li>
            <div className="row space-between">
              <strong>连接状态</strong>
              <span className={status.session.state === "connected" ? "ok-text" : "warn"}>{STATE_LABELS[status.session.state]}</span>
            </div>
            <div className="meta">
              <span>AppID：{status.appId ?? "—"}</span>
              <span>环境：{status.sandbox === true ? "沙箱" : "正式"}</span>
              <span>密钥：{status.credentialsSaved ? "已保存" : "未保存"}</span>
              <span>访问凭证：{status.token.state === "valid" ? "有效" : status.token.state === "expired" ? "已过期（会自动重取）" : "还没取"}</span>
            </div>
            <div className="meta">
              <span>最近事件：{status.session.lastEventAt === null ? "—" : status.session.lastEventAt.slice(0, 16).replace("T", " ")}</span>
              <span>重连次数：{status.session.consecutiveFailures}</span>
              <span>连接建立次数：{status.session.gatewaySessions}</span>
            </div>
            {status.session.lastError !== null && <p className="warn">最近错误：{status.session.lastError}</p>}
          </li>
        </ul>
      )}

      <div className="grid">
        <label>
          AppID
          <input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="例如 102000001" />
        </label>
        <label>
          ClientSecret
          <input
            type="password"
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder={status?.credentialsSaved === true ? "已保存，留空表示沿用" : "粘贴机器人的 ClientSecret"}
          />
        </label>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={sandbox} onChange={(event) => setSandbox(event.target.checked)} />
        用沙箱环境（还没上线的机器人勾这个）
      </label>

      <div className="row">
        <button
          disabled={busy || appId.trim().length === 0 || (status?.credentialsSaved !== true && clientSecret.length === 0)}
          onClick={() =>
            void run(async () => {
              await api.qqSaveConfig({
                appId: appId.trim(),
                ...(clientSecret.length > 0 ? { clientSecret } : {}),
                sandbox,
              });
              setClientSecret("");
            }, "已保存并开始连接。")
          }
        >
          {busy ? "处理中…" : "保存并连接"}
        </button>
        <button className="ghost" disabled={busy || status?.configured !== true} onClick={() => void run(() => api.qqReconnect(), "已重新连接。")}>
          重新连接
        </button>
        <button className="ghost" disabled={busy || status?.configured !== true} onClick={() => void run(() => api.qqDisconnect(), "已断开。")}>
          断开
        </button>
        <button
          className="danger"
          disabled={busy || status?.credentialsSaved !== true}
          onClick={() => {
            if (window.confirm("清除已保存的 ClientSecret？AppID 会留着，但连接会断开，直到你重新填密钥。"))
              void run(() => api.qqClearCredentials(), "密钥已清除。");
          }}
        >
          清除密钥
        </button>
      </div>
      {note !== null && <p className="hint">{note}</p>}

      <p className="hint">
        密钥只保存在本机加密库里，界面与接口都不会回显它。连接用的是官方网关（WebSocket）：机器人被 @ 或收到私聊时会实时推过来。
      </p>
    </section>
  );
}

