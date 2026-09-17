import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { CharacterDto, EmotionHistoryItemDto, EmotionViewDto, RelationshipItemDto } from "../lib/types.ts";

const STAGE_LABELS: Record<string, string> = {
  stranger: "还很陌生",
  acquaintance: "刚认识",
  friend: "朋友",
  close: "亲近",
  beloved: "很重要的人",
  strained: "关系有点紧张",
};

const DIMENSION_LABELS: Array<[keyof RelationshipItemDto["dimensions"], string]> = [
  ["familiarity", "熟悉度"],
  ["trust", "信任"],
  ["affection", "好感"],
  ["intimacy", "亲密"],
  ["respect", "尊重"],
  ["dependence", "依赖"],
];

export function RelationshipPage(props: { characters: CharacterDto[]; onError: (message: string) => void }) {
  const [items, setItems] = useState<RelationshipItemDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.relationshipDetail>> | null>(null);
  const [emotion, setEmotion] = useState<EmotionViewDto | null>(null);
  const [showNumbers, setShowNumbers] = useState(false);

  const refresh = async () => {
    try {
      const relationships = await api.relationships();
      setItems(relationships);
      const target = activeId ?? relationships[0]?.characterId ?? null;
      if (target !== null) {
        setActiveId(target);
        setDetail(await api.relationshipDetail(target));
        setEmotion(await api.emotion(target));
      }
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function select(characterId: string) {
    setActiveId(characterId);
    try {
      setDetail(await api.relationshipDetail(characterId));
      setEmotion(await api.emotion(characterId));
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  /** 删掉一条记录：只删记录本身，当前关系数值/情绪状态不会被回滚。 */
  async function remove(kind: "change" | "milestone" | "emotion", id: string, label: string) {
    if (activeId === null) return;
    const what = kind === "change" ? "这条关系变化记录" : kind === "milestone" ? "里程碑「" + label + "」" : "这条情绪记录";
    if (!window.confirm("确定删除" + what + "吗？删掉后不会恢复，但当前的关系数值与情绪不会跟着变。")) return;
    try {
      if (kind === "change") await api.deleteRelationshipChange(activeId, id);
      else if (kind === "milestone") await api.deleteRelationshipMilestone(activeId, id);
      else await api.deleteEmotionHistory(activeId, id);
      await select(activeId);
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  const active = items.find((item) => item.characterId === activeId) ?? null;

  return (
    <section className="panel">
      <h2>关系</h2>
      <p className="hint">关系是长期状态，不会因为一次聊天就大起大落。</p>

      <div className="conversations">
        {items.map((item) => (
          <button key={item.characterId} className={item.characterId === activeId ? "active" : ""} onClick={() => void select(item.characterId)}>
            {item.characterName}
          </button>
        ))}
      </div>

      {active !== null && (
        <>
          <div className="stage-card">
            <strong>{STAGE_LABELS[active.stage] ?? active.stage}</strong>
            <span className="score">更新于 {active.updatedAt.slice(0, 16).replace("T", " ")}</span>
          </div>

          <label className="toggle">
            <input type="checkbox" checked={showNumbers} onChange={(event) => setShowNumbers(event.target.checked)} />
            高级：显示具体数值
          </label>

          {showNumbers && (
            <div className="dims">
              {DIMENSION_LABELS.map(([key, label]) => {
                const value = active.dimensions[key];
                return (
                  <div key={key} className="dim">
                    <span>{label}</span>
                    <div className="bar">
                      <div className="fill" style={{ width: `${Math.round(value * 100)}%` }} />
                    </div>
                    <span className="score">{value.toFixed(2)}</span>
                  </div>
                );
              })}
            </div>
          )}

          {detail !== null && (
            <>
              <h3>最近的变化</h3>
              <p className="hint">删掉某条记录只会让它从这里消失，当前的关系数值不会跟着回退。</p>
              <ul className="cards">
                {detail.changes.slice(0, 8).map((change) => (
                  <li key={change.id}>
                    <div className="row space-between">
                      <span>{change.reason}</span>
                      <span className="score">
                        {change.dimension} {change.delta >= 0 ? "+" : ""}
                        {change.delta.toFixed(3)}
                      </span>
                    </div>
                    <div className="meta">
                      <span>{change.source}</span>
                      <span>{change.createdAt.slice(0, 16).replace("T", " ")}</span>
                    </div>
                    <div className="row">
                      <button className="danger" onClick={() => void remove("change", change.id, change.reason)}>
                        删除这条记录
                      </button>
                    </div>
                  </li>
                ))}
                {detail.changes.length === 0 && <li className="empty">还没有变化记录。</li>}
              </ul>

              <h3>里程碑</h3>
              <ul className="cards">
                {detail.milestones.map((milestone) => (
                  <li key={milestone.id}>
                    <div className="row space-between">
                      <span>{milestone.label}</span>
                      <span className="score">{milestone.at.slice(0, 10)}</span>
                    </div>
                    <div className="row">
                      <button className="danger" onClick={() => void remove("milestone", milestone.id, milestone.label)}>
                        删除
                      </button>
                    </div>
                  </li>
                ))}
                {detail.milestones.length === 0 && <li className="empty">还没有里程碑。</li>}
              </ul>
            </>
          )}
        </>
      )}

      {emotion !== null && (
        <>
          <h2>情绪</h2>
          <div className="stage-card">
            <strong>{emotion.emotion.primary}</strong>
            <span className="score">强度 {(emotion.emotion.intensity * 100).toFixed(0)}%</span>
            <span className="score">心情：{emotion.mood}</span>
          </div>
          <div className="meta">
            <span>正在：{emotion.activity.label}</span>
            <span>地点：{emotion.location.label}</span>
            <span>精力：{emotion.energy.toFixed(2)}</span>
            <span>起因：{emotion.emotion.reason}</span>
          </div>

          <h3>最近的情绪变化</h3>
          <p className="hint">删掉某条情绪记录只会让它从这里消失，角色现在的情绪不变。</p>
          <ul className="cards">
            {emotion.history.slice(0, 8).map((entry: EmotionHistoryItemDto) => (
              <li key={entry.id}>
                <div className="row space-between">
                  <span>
                    {entry.before?.primary ?? "—"} → {entry.after.primary}
                  </span>
                  <span className="score">{(entry.intensity * 100).toFixed(0)}%</span>
                </div>
                <div className="meta">
                  <span>{entry.reason}</span>
                  <span>{entry.source}</span>
                  <span>{entry.createdAt.slice(0, 16).replace("T", " ")}</span>
                </div>
                <div className="row">
                  <button className="danger" onClick={() => void remove("emotion", entry.id, entry.reason)}>
                    删除这条记录
                  </button>
                </div>
              </li>
            ))}
            {emotion.history.length === 0 && <li className="empty">还没有情绪记录。</li>}
          </ul>
        </>
      )}
    </section>
  );
}
