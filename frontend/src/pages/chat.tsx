import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { CharacterDto, ContextPreviewDto, ConversationDto, MessageDto } from "../lib/types.ts";
import { audioTranscription, mediaPlaceholders } from "../lib/parts.ts";
import { MicIcon, SpeakerIcon } from "../lib/icons.tsx";

/** 会话来源的中文标签：来源是会话自身的属性，不混进角色名 */
const SOURCE_LABELS: Record<string, string> = { web: "网页", weixin: "微信" };

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** 列表里的时间：今天只显示时分，其它日期带上月日 */
function formatTime(iso: string | null): string {
  if (iso === null) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hhmm = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return hhmm;
  return String(date.getMonth() + 1) + "-" + String(date.getDate()) + " " + hhmm;
}

export function ChatPage(props: {
  characters: CharacterDto[];
  conversations: ConversationDto[];
  activeConversation: string | null;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => Promise<void>;
  /** 正在删除的会话 id：删除按钮据此禁用，避免连点 */
  deletingConversationId: string | null;
  onError: (message: string) => void;
  streamingText: string;
  streamingRunId: string | null;
  onUserMessageSent: () => void;
}) {
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<ContextPreviewDto | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  /** 当前聊天实际会用的 provider / model（来自后端的路由解析结果；不含任何密钥） */
  const [chatModel, setChatModel] = useState<{ providerId: string; model: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activeConversation = props.conversations.find((entry) => entry.id === props.activeConversation) ?? null;
  const activeCharacter = props.characters.find((entry) => entry.id === activeConversation?.characterId) ?? null;

  const refresh = async () => {
    if (props.activeConversation === null) {
      setMessages([]);
      return;
    }
    try {
      setMessages(await api.messages(props.activeConversation));
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.activeConversation]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, props.streamingText]);

  useEffect(() => {
    void api
      .routing()
      .then((items) => {
        const chat = items.find((item) => item.taskType === "chat") ?? null;
        setChatModel(chat === null ? null : chat.resolved);
      })
      .catch(() => setChatModel(null));
  }, []);

  async function handleSend() {
    const text = draft.trim();
    if (props.activeConversation === null || text.length === 0) return;
    setDraft("");
    try {
      await api.streamMessage(props.activeConversation, text);
      props.onUserMessageSent();
      await refresh();
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  async function handlePreview() {
    if (props.activeConversation === null) return;
    try {
      setPreview(await api.contextPreview(props.activeConversation, draft.trim().length > 0 ? draft.trim() : "（预览：下一条消息）"));
      setShowPreview(true);
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  return (
    <section className="panel">
      <div className="row space-between">
        <h2>
          {activeCharacter?.name ?? "未选择角色"}
          {activeConversation !== null && (
            <span className={"source-badge source-" + (activeConversation.source === "weixin" ? "weixin" : "web")}>
              {sourceLabel(activeConversation.source)}聊天
            </span>
          )}
        </h2>
        {chatModel !== null && (
          <span className="hint">
            当前模型：{chatModel.providerId} / {chatModel.model}
          </span>
        )}
        <div className="row">
          <button className="ghost" disabled={props.activeConversation === null} onClick={() => void handlePreview()}>
            查看上下文
          </button>
          {props.streamingRunId !== null && (
            <button className="danger" onClick={() => void api.abortRun(props.streamingRunId!).then(() => props.onError("已请求中断生成"))}>
              停止生成
            </button>
          )}
        </div>
      </div>

      <div className="conversations">
        {props.conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={"conversation-item" + (conversation.id === props.activeConversation ? " active" : "")}
          >
            <button className="conversation-main" onClick={() => props.onSelectConversation(conversation.id)}>
              <span className={"source-badge source-" + (conversation.source === "weixin" ? "weixin" : "web")}>
                {sourceLabel(conversation.source)}
              </span>
              <span className="conversation-name">
                {props.characters.find((character) => character.id === conversation.characterId)?.name ?? conversation.title}
              </span>
              <span className="conversation-time">{formatTime(conversation.lastMessageAt)}</span>
              <span className="conversation-preview">{conversation.lastMessageText ?? "（还没有消息）"}</span>
            </button>
            <button
              className="conversation-delete"
              title="删除这个会话"
              disabled={props.deletingConversationId === conversation.id}
              onClick={() => void props.onDeleteConversation(conversation.id)}
            >
              删除
            </button>
          </div>
        ))}
        {props.conversations.length === 0 && <p className="hint">还没有会话：到「角色」页点「开始聊天」新建一个。</p>}
      </div>

      {/* role="log" 是聊天记录的标准语义：新消息会被读屏念出来；正在流式生成时标 busy，免得半句话半句话地念 */}
      <div
        className="messages"
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-busy={props.streamingText.length > 0}
        aria-label="对话记录"
      >
        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "message user" : "message character"}>
            <span className="role">
              {message.role === "user" ? "我" : (activeCharacter?.name ?? "角色")}
              {message.status === "failed" && <span className="warn">（生成失败）</span>}
              {message.status === "partial" && <span className="warn">（生成中）</span>}
            </span>
            <p>{message.text || (message.status === "failed" ? "" : "…")}</p>
            {mediaPlaceholders(message.parts).length > 0 && (
              <div className="meta">
                {mediaPlaceholders(message.parts).map((placeholder, index) => (
                  <span key={index} className="tag">
                    {placeholder}
                  </span>
                ))}
              </div>
            )}
            {/* Phase 4.5-D4：助手回复的语音状态（只做展示；不自动重新生成） */}
            {message.role !== "user" && message.tts !== undefined && (
              <div className="meta">
                <span className="tag">
                  <SpeakerIcon />
                  语音
                </span>
                {message.tts.status === "completed" && <span className="hint">语音已生成</span>}
                {(message.tts.status === "processing" || message.tts.status === "pending") && <span className="hint">语音生成中…</span>}
                {message.tts.status === "failed" && <span className="hint">语音不可用</span>}
                {message.tts.status === "failed" && (
                  <button
                    type="button"
                    className="link"
                    onClick={async () => {
                      try {
                        const updated = await api.generateSpeech(message.id, true);
                        setMessages((current) => current.map((item) => (item.id === updated.id ? updated : item)));
                      } catch (error) {
                        props.onError((error as Error).message);
                      }
                    }}
                  >
                    重试
                  </button>
                )}
              </div>
            )}
            {/* Phase 4.5-D3：语音消息的转写状态（只做展示，没有音频编辑器） */}
            {(message.parts ?? [])
              .filter((part) => part.kind === "audio")
              .map((part, index) => {
                const view = audioTranscription(part);
                // Phase 4.5-E：媒体本身不可用（下载/解密失败）也要如实显示，不能只显示占位符
                const mediaStatus = (part as { media?: { status?: string } }).media?.status;
                const mediaUnavailable = mediaStatus === "failed" || mediaStatus === "expired";
                if (view.kind === "none" && !mediaUnavailable) return null;
                return (
                  <div key={"asr-" + String(index)} className="meta">
                    <span className="tag">
                      <MicIcon />
                      语音消息
                    </span>
                    {mediaUnavailable && <span className="hint">音频不可用</span>}
                    {!mediaUnavailable && view.kind === "pending" && <span className="hint">转写中…</span>}
                    {!mediaUnavailable && view.kind === "completed" && <span className="transcript">{view.text}</span>}
                    {!mediaUnavailable && view.kind === "failed" && <span className="hint">转写不可用</span>}
                  </div>
                );
              })}
          </div>
        ))}
        {props.streamingText.length > 0 && (
          <div className="message character streaming">
            <span className="role">{activeCharacter?.name ?? "角色"}（正在输入…）</span>
            <p>{props.streamingText}</p>
          </div>
        )}
        {messages.length === 0 && props.streamingText.length === 0 && <p className="hint">还没有消息。</p>}
      </div>

      <div className="composer">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSend();
          }}
          placeholder={props.activeConversation === null ? "先选择或创建一个会话" : "说点什么…"}
          disabled={props.activeConversation === null}
        />
        <button disabled={props.activeConversation === null} onClick={() => void handleSend()}>
          发送
        </button>
      </div>

      {showPreview && preview !== null && (
        <div className="modal wide">
          <div className="row space-between">
            <h3>这一轮模型会看到什么</h3>
            <button className="ghost" onClick={() => setShowPreview(false)}>
              关闭
            </button>
          </div>
          <p className="hint">
            模型：{preview.model.providerId} / {preview.model.model} ・ 预计 {preview.totalTokens} / {preview.budgetTokens} tokens
          </p>
          {preview.sections.map((section, index) => (
            <div key={`${section.kind}-${index}`} className="context-section">
              <div className="row space-between">
                <strong>{section.title}</strong>
                <span className="score">
                  {section.kind} ・ {section.tokenEstimate} tokens{section.truncated ? " ・ 已截断" : ""}
                </span>
              </div>
              <pre>{section.text}</pre>
            </div>
          ))}
          {preview.dropped.length > 0 && (
            <div className="context-section">
              <strong>被丢弃的内容</strong>
              <ul>
                {preview.dropped.map((drop, index) => (
                  <li key={index}>
                    {drop.kind}：{drop.reason}（{drop.detail}）
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}