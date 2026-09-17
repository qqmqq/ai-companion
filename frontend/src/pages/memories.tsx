import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { MemoryDto, MemoryHitDto, MessageDto } from "../lib/types.ts";

export function MemoriesPage(props: { characterId: string | null; onError: (message: string) => void }) {
  const [memories, setMemories] = useState<MemoryDto[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<MemoryHitDto[] | null>(null);
  const [detail, setDetail] = useState<{ memory: MemoryDto; sourceMessage: MessageDto | null } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = async () => {
    try {
      const response = await api.memories(props.characterId ?? undefined);
      setMemories(response.items);
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.characterId]);

  async function handleSearch() {
    if (query.trim().length === 0) {
      setHits(null);
      return;
    }
    try {
      const response = await api.searchMemories(query.trim(), props.characterId ?? undefined);
      setHits(response.items);
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  return (
    <section className="panel">
      <h2>记忆（{memories.length}）</h2>
      <p className="hint">角色长期记住的内容。重要度越高越不容易随时间淡忘；承诺与身份类记忆永不自动遗忘。</p>

      <div className="row">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSearch();
          }}
          placeholder="搜索记忆，例如：咖啡"
        />
        <button onClick={() => void handleSearch()}>搜索</button>
        <button className="ghost" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {hits !== null && (
        <div className="search-results">
          <h3>检索结果（{hits.length}）</h3>
          {hits.length === 0 && <p className="hint">没有命中。试试别的关键词。</p>}
          {hits.map((hit) => (
            <div key={hit.memory.id} className="memory-card">
              <div className="row space-between">
                <strong>{hit.memory.content}</strong>
                <span className="score">{"综合 "}{hit.score.toFixed(3)}</span>
              </div>
              {showAdvanced && (
                <div className="meta">
                  <span>关键词 {hit.components.fts.toFixed(2)}</span>
                  <span>重要度 {hit.components.importance.toFixed(2)}</span>
                  <span>新鲜度 {hit.components.recency.toFixed(2)}</span>
                  <span>强化 {hit.components.reinforcement.toFixed(2)}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ul className="cards">
        {memories.map((memory) => (
          <li key={memory.id}>
            <div className="row space-between">
              <strong>{memory.content}</strong>
              <span className="score">重要度 {memory.importance.toFixed(2)}</span>
            </div>
            <div className="meta">
              <span>{memory.type}</span>
              <span>{memory.scope}</span>
              {memory.tags.map((tag) => (
                <span key={tag} className="tag">
                  #{tag}
                </span>
              ))}
              {memory.status !== "active" && <span className="warn">{memory.status}</span>}
            </div>
            <div className="row">
              <button className="ghost" onClick={() => void api.memoryDetail(memory.id).then((d) => setDetail({ memory: d.memory, sourceMessage: d.sourceMessage })).catch((error: Error) => props.onError(error.message))}>
                来源
              </button>
              <button
                className="ghost"
                onClick={() =>
                  void api
                    .updateMemoryImportance(memory.id, memory.importance >= 0.9 ? 0.5 : Math.min(1, memory.importance + 0.2))
                    .then(() => refresh())
                    .catch((error: Error) => props.onError(error.message))
                }
              >
                调整重要度
              </button>
              <button
                className="danger"
                onClick={() =>
                  void api
                    .deleteMemory(memory.id)
                    .then(() => refresh())
                    .catch((error: Error) => props.onError(error.message))
                }
              >
                删除
              </button>
            </div>
          </li>
        ))}
        {memories.length === 0 && <li className="empty">还没有记忆。多聊几轮，角色会开始记住你的事。</li>}
      </ul>

      <label className="toggle">
        <input type="checkbox" checked={showAdvanced} onChange={(event) => setShowAdvanced(event.target.checked)} />
        高级：显示打分细节
      </label>

      {detail !== null && (
        <div className="modal">
          <h3>记忆来源</h3>
          <p>{detail.memory.content}</p>
          <pre>{detail.sourceMessage?.text ?? "（来源消息已不可用）"}</pre>
          <button onClick={() => setDetail(null)}>关闭</button>
        </div>
      )}
    </section>
  );
}
