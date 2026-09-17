import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api } from "../lib/api.ts";
import type { CharacterDto, ConversationDto, WeixinAccountDto, WeixinLoginDto, WeixinStatusDto } from "../lib/types.ts";

const STATE_LABELS: Record<WeixinAccountDto["state"], string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  credential_invalid: "登录已失效",
  stopped: "已停止",
};

/** 普通用户只需要看到"要做什么"，不需要理解协议内部的阶段名。 */
const PHASE_HINTS: Record<WeixinLoginDto["phase"], string> = {
  waiting_scan: "请用手机微信扫描下方二维码",
  scanned: "已扫码，请在手机上点击确认",
  need_verifycode: "请输入手机微信上显示的验证码",
  verify_code_blocked: "验证码错误次数过多，请重新获取二维码",
  expired: "二维码已过期，请重新获取",
  redirected: "正在切换登录服务器，请稍候",
  already_bound: "这个微信已经绑定过本程序了，无需重复登录",
  logged_in: "登录成功",
  failed: "登录失败，请重试",
  cancelled: "已取消登录",
};

export function WeixinPage(props: { characters: CharacterDto[]; onError: (message: string) => void }) {
  const [status, setStatus] = useState<WeixinStatusDto | null>(null);
  const [login, setLogin] = useState<WeixinLoginDto | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [busy, setBusy] = useState(false);
  /** 微信侧的聊天（每个联系人一条），换角色的入口就在这里 */
  const [chats, setChats] = useState<ConversationDto[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [switching, setSwitching] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const refresh = async () => {
    try {
      setStatus(await api.weixinStatus());
      setChats((await api.conversations()).filter((conversation) => conversation.channel === "weixin"));
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  /**
   * 后台换角色：与微信里发「切换角色 X」走的是同一条核心逻辑。
   * 换到没聊过的角色会开新会话，并把那句开场白发到微信。
   */
  async function switchCharacter(chat: ConversationDto) {
    const characterId = pick[chat.id] ?? "";
    if (characterId.length === 0) return;
    setSwitching(chat.id);
    try {
      const result = await api.switchConversationCharacter(chat.id, characterId);
      const note = result.newConversation
        ? result.delivered
          ? "已切换到「" + result.characterName + "」，开场白已发到微信：「" + result.text + "」"
          : "已切换到「" + result.characterName + "」，但开场白没发出去（" + (result.deliveryError ?? "未知原因") + "）—— 你可以在微信里先发一条消息试试。"
        : result.text;
      setNotes((previous) => ({ ...previous, [chat.id]: note }));
      await refresh();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setSwitching(null);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 二维码图片里必须编码"可扫码内容"（qrcode_img_content，形如 liteapp.weixin.qq.com/q/...?qrcode=<hex>&bot_type=3）；
  // 服务端返回的裸 qrcode 只是轮询用的会话标识，直接编进二维码扫出来是一串无意义的十六进制。
  const qrPayload = login?.qrcodeImageContent ?? login?.qrcode ?? null;

  // 渲染二维码（内容里只有一次性会话标识，不含任何凭证）
  useEffect(() => {
    if (qrPayload == null || canvasRef.current === null) return;
    void QRCode.toCanvas(canvasRef.current, qrPayload, { width: 220, margin: 1 }).catch(() => {});
  }, [qrPayload]);

  /**
   * 登录状态轮询：**一次只发一个请求**，等它回来再排下一次。
   *
   * 为什么不能再用 setInterval：get_qrcode_status 是长轮询接口（服务端约 30s 才回）。
   * 固定 1.5s 间隔会在 30s 内堆出十几个并发请求，既压垮自己的后端/上游，
   * 又会让**迟到的旧响应覆盖新状态**（例如已扫码却又被打回"等待扫描"）。
   * 依赖只保留 sessionId：状态变化不再重启轮询（重启同样会造成重复请求）。
   */
  useEffect(() => {
    if (login === null) return;
    const sessionId = login.sessionId;
    const terminal = ["logged_in", "failed", "cancelled", "already_bound", "expired"];
    let cancelled = false;
    let timer: number | null = null;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const next = await api.weixinPollLogin(sessionId);
        if (cancelled) return;
        setLogin(next);
        if (next.phase === "logged_in") {
          await api.weixinCompleteLogin(next.sessionId);
          if (cancelled) return;
          setLogin(null);
          await refresh();
          return;
        }
        if (terminal.includes(next.phase)) return;
      } catch {
        // 单次失败（网络抖动 / 上游超时）不终止轮询，等下一轮
      }
      if (!cancelled) timer = window.setTimeout(() => void tick(), 300);
    };

    timer = window.setTimeout(() => void tick(), 300);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.sessionId]);

  async function startLogin() {
    setBusy(true);
    try {
      setLogin(await api.weixinStartLogin());
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>微信</h2>
      <p className="hint">
        让你的角色可以通过微信和你聊天。当前版本只支持文字消息；图片、语音等会在后续版本加入。
      </p>

      <div className="stage-card">
        <strong>{status?.enabled === false ? "微信通道未启用" : "微信通道已启用"}</strong>
        <span className="score">已添加账号：{status?.accounts.length ?? 0}</span>
        {status?.health.message !== null && status?.health.message !== undefined && <span className="warn">{status.health.message}</span>}
      </div>

      <h3>添加微信账号</h3>
      {login === null ? (
        <div className="row">
          <button disabled={busy} onClick={() => void startLogin()}>
            扫码添加
          </button>
          <button className="ghost" onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>
      ) : (
        <>
          <p className="hint">{PHASE_HINTS[login.phase]}</p>
          {qrPayload !== null && <canvas ref={canvasRef} className="qr-canvas" />}
          {qrPayload !== null && (
            <p className="hint">
              二维码内容（手机扫不出来时可复制这行给其他工具生成）：<code>{qrPayload}</code>
            </p>
          )}
          {login.needsVerifyCode && (
            <div className="row">
              <input value={verifyCode} onChange={(event) => setVerifyCode(event.target.value)} placeholder="手机微信上显示的验证码" />
              <button
                onClick={() =>
                  void api
                    .weixinSubmitCode(login.sessionId, verifyCode.trim())
                    .then((next) => {
                      setLogin(next);
                      setVerifyCode("");
                    })
                    .catch((error: Error) => props.onError(error.message))
                }
              >
                提交验证码
              </button>
            </div>
          )}
          {["expired", "failed", "already_bound"].includes(login.phase) && (
            <div className="row">
              <button onClick={() => void startLogin()}>重新获取二维码</button>
              <button className="ghost" onClick={() => setLogin(null)}>
                关闭
              </button>
            </div>
          )}
          {!["expired", "failed", "already_bound"].includes(login.phase) && (
            <div className="row">
              <button
                className="ghost"
                onClick={() =>
                  void api.weixinCancelLogin(login.sessionId).then(() => setLogin(null)).catch((error: Error) => props.onError(error.message))
                }
              >
                取消
              </button>
            </div>
          )}
          <p className="hint">
            刷新次数 {login.refreshCount} ・ 有效期至 {login.expiresAt.slice(11, 16)}
          </p>
        </>
      )}

      <h3>在跟谁聊（可以在这里换角色）</h3>
      <p className="hint">
        两种换法效果完全一样：这里点着换，或者在微信里直接发「切换角色 名字」（发「角色列表」看有哪些人）。
        换到没聊过的角色会开一个新会话，并把那个角色的开场白发到微信；换回以前聊过的角色则接着原来的会话。
      </p>
      <ul className="cards">
        {chats.map((chat) => {
          const activeId = chat.activeCharacterId ?? null;
          const current = props.characters.find((character) => character.id === (activeId ?? chat.characterId)) ?? null;
          const note = notes[chat.id];
          return (
            <li key={chat.id}>
              <div className="row space-between">
                <strong>{current?.name ?? "未知角色"}</strong>
                <span className={activeId === null ? "score" : "ok-text"}>
                  {activeId === null ? "● 未指定（按第一个角色回复）" : "● 现在在聊"}
                </span>
              </div>
              <div className="meta">
                <span>最近消息：{chat.lastMessageText === null || chat.lastMessageText.length === 0 ? "—" : chat.lastMessageText.slice(0, 30)}</span>
                <span>最后活跃：{chat.lastMessageAt === null ? "—" : chat.lastMessageAt.slice(0, 16).replace("T", " ")}</span>
              </div>
              <div className="row">
                <select
                  value={pick[chat.id] ?? ""}
                  onChange={(event) => setPick((previous) => ({ ...previous, [chat.id]: event.target.value }))}
                >
                  <option value="">选一个角色…</option>
                  {props.characters.map((character) => (
                    <option key={character.id} value={character.id}>
                      {character.name}（第 {character.versionCount} 版）
                    </option>
                  ))}
                </select>
                <button
                  disabled={(pick[chat.id] ?? "").length === 0 || switching === chat.id || props.characters.length === 0}
                  onClick={() => void switchCharacter(chat)}
                >
                  {switching === chat.id ? "切换中…" : "切换到这个角色"}
                </button>
              </div>
              {note !== undefined && <p className="hint">{note}</p>}
            </li>
          );
        })}
        {chats.length === 0 && (
          <li className="empty">还没有微信聊天。对方在微信里发一条消息，这里就会出现。</li>
        )}
      </ul>
      {props.characters.length === 0 && <p className="hint">你还没有角色，先在「角色」页建一个（可以用角色工坊让 AI 补全）。</p>}

      <h3>已连接的微信</h3>
      <ul className="cards">
        {(status?.accounts ?? []).map((account) => (
          <li key={account.accountId}>
            <div className="row space-between">
              <strong>{account.displayName}</strong>
              <span className={account.loggedIn ? "ok-text" : "warn"}>
                {account.requiresRelogin ? "需要重新登录" : STATE_LABELS[account.state]}
              </span>
            </div>
            <div className="meta">
              <span>最近活动：{account.lastEventAt === null ? "—" : account.lastEventAt.slice(0, 16).replace("T", " ")}</span>
              {account.consecutiveFailures > 0 && <span>连续失败 {account.consecutiveFailures} 次</span>}
            </div>
            {account.lastError !== null && <p className="warn">最近错误：{account.lastError}</p>}
            <div className="row">
              {account.requiresRelogin && (
                <button
                  onClick={() =>
                    void api
                      .weixinRelogin(account.accountId)
                      .then(() => refresh())
                      .catch((error: Error) => props.onError(error.message))
                  }
                >
                  重新连接
                </button>
              )}
              <button
                className="danger"
                onClick={() =>
                  void api
                    .weixinRemoveAccount(account.accountId)
                    .then(() => refresh())
                    .catch((error: Error) => props.onError(error.message))
                }
              >
                删除账号
              </button>
            </div>
          </li>
        ))}
        {(status?.accounts ?? []).length === 0 && <li className="empty">还没有添加微信账号。</li>}
      </ul>
    </section>
  );
}
