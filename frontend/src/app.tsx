import { useEffect, useState } from "react";
import { api, type StreamEvent } from "./lib/api.ts";
import type { CharacterDto, ConversationDto } from "./lib/types.ts";
import { CharactersPage } from "./pages/characters.tsx";
import { ChatPage } from "./pages/chat.tsx";
import { MemoriesPage } from "./pages/memories.tsx";
import { SettingsPage } from "./pages/settings.tsx";
import { RelationshipPage } from "./pages/relationship.tsx";
import { TimelinePage } from "./pages/timeline.tsx";
import { ProactivePage } from "./pages/proactive.tsx";
import { WeixinPage } from "./pages/weixin.tsx";

type Tab = "characters" | "chat" | "memories" | "relationship" | "timeline" | "proactive" | "weixin" | "settings";

export function App() {
  const [tab, setTab] = useState<Tab>("characters");
  const [characters, setCharacters] = useState<CharacterDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConversation, setActiveConversation] = useState<string | null>(null);
  /** 正在删除的会话（删除按钮据此禁用，避免连点造成重复请求） */
  const [deletingConversation, setDeletingConversation] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshCharacters = async () => setCharacters(await api.characters());
  const refreshConversations = async () => setConversations(await api.conversations());

  useEffect(() => {
    void refreshCharacters().catch((e: Error) => setError(e.message));
    void refreshConversations().catch((e: Error) => setError(e.message));
  }, []);

  // 流式增量通过 SSE 到达：把 chunk 拼成一条正在输入的消息，而不是插入多条
  useEffect(() => {
    return api.subscribeEvents((event: StreamEvent) => {
      if (event.name !== "message.delta") return;
      const payload = event.payload;
      if (payload.delta !== undefined && payload.runId !== undefined) {
        setStreamingRunId(payload.runId);
        setStreamingText((previous) => previous + payload.delta);
        return;
      }
      if (payload.complete === true) {
        setStreamingText("");
        setStreamingRunId(null);
        void refreshConversations();
        if (payload.error !== undefined) setError(payload.error);
      }
    });
  }, [activeConversation]);

  const activeCharacterId = conversations.find((entry) => entry.id === activeConversation)?.characterId ?? null;

  /**
   * 删除会话：确认后只删这一个会话。
   * - 删掉的正好是当前打开的会话 → 自动回到「未选择会话」状态，不停留在已删除的会话里；
   * - 重复删除 / 已经被别处删掉 → 按"已删除"处理并刷新列表，不把数据库错误弹给用户。
   */
  async function handleDeleteConversation(conversationId: string) {
    if (!window.confirm("确定删除这个会话吗？会话里的消息会一起删除，角色本身不受影响。")) return;
    setDeletingConversation(conversationId);
    try {
      await api.deleteConversation(conversationId);
      if (activeConversation === conversationId) setActiveConversation(null);
      await refreshConversations();
    } catch (e) {
      const message = (e as Error).message;
      if (/not found|404/i.test(message)) {
        if (activeConversation === conversationId) setActiveConversation(null);
        await refreshConversations();
      } else {
        setError(message);
      }
    } finally {
      setDeletingConversation(null);
    }
  }

  async function handleStartChat(character: CharacterDto, options: { newSession?: boolean } = {}) {
    try {
      const conversation = await api.createConversation(character.id, options);
      await refreshConversations();
      setActiveConversation(conversation.id);
      setTab("chat");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>AI Companion</h1>
        <nav>
          {(
            [
              ["characters", "角色"],
              ["chat", "聊天"],
              ["memories", "记忆"],
              ["relationship", "关系与情绪"],
              ["timeline", "事件与任务"],
              ["proactive", "主动消息"],
              ["weixin", "微信"],
              ["settings", "模型设置"],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>
      </header>

      {error !== null && (
        <div className="error" onClick={() => setError(null)}>
          出错了：{error}
          <span className="hint">（点击关闭）</span>
        </div>
      )}

      {tab === "characters" && (
        <CharactersPage
          characters={characters}
          onChanged={refreshCharacters}
          onStartChat={handleStartChat}
          onError={setError}
        />
      )}
      {tab === "chat" && (
        <ChatPage
          characters={characters}
          conversations={conversations}
          activeConversation={activeConversation}
          onSelectConversation={setActiveConversation}
          onDeleteConversation={handleDeleteConversation}
          deletingConversationId={deletingConversation}
          onError={setError}
          streamingText={streamingText}
          streamingRunId={streamingRunId}
          onUserMessageSent={() => {
            setStreamingText("");
          }}
        />
      )}
      {tab === "memories" && <MemoriesPage characterId={activeCharacterId} onError={setError} />}
      {tab === "relationship" && <RelationshipPage characters={characters} onError={setError} />}
      {tab === "timeline" && <TimelinePage characters={characters} onError={setError} />}
      {tab === "proactive" && <ProactivePage characters={characters} onError={setError} />}
      {tab === "weixin" && <WeixinPage characters={characters} onError={setError} />}
      {tab === "settings" && <SettingsPage onError={setError} />}
    </div>
  );
}