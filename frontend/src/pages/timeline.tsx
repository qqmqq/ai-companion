import { useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import type { CharacterDto, EventDto, JobDto, TaskDto } from "../lib/types.ts";
import { channelLabel, formatMoment, jobKindLabel, jobStatusLabel, nextRunText, rawValue, taskStatusLabel } from "../lib/labels.ts";

/** 定时提醒的原文：payload.message 是用户/角色当初说要提醒的那句话 */
function reminderText(job: JobDto): string {
  const message = job.payload?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : jobKindLabel(job.kind);
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  promise: "承诺",
  future_plan: "计划",
  anniversary: "纪念日",
  shared_experience: "共同经历",
  important_conversation: "重要对话",
  user_info: "用户信息",
  relationship_change: "关系变化",
  character_life: "角色自己的事",
  custom: "其他",
};

const STATUS_LABELS: Record<string, string> = {
  planned: "计划中",
  active: "进行中",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已过期",
};

/** 筛选器里代表「不属于某个角色」的哨兵值 */
const NO_CHARACTER = "__none__";

interface Group<T> {
  /** 角色 id；通用组为 null */
  id: string | null;
  name: string;
  items: T[];
}

export function TimelinePage(props: { characters: CharacterDto[]; onError: (message: string) => void }) {
  const [events, setEvents] = useState<EventDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [reminders, setReminders] = useState<JobDto[]>([]);
  const [form, setForm] = useState({ characterId: "", type: "promise", title: "", description: "", dueAt: "" });
  /** 按角色看：空 = 全部，角色 id = 只看他的，NO_CHARACTER = 只看不属于某个角色的 */
  const [filter, setFilter] = useState("");

  const refresh = async () => {
    try {
      const [nextEvents, nextTasks, jobs] = await Promise.all([api.events(), api.tasks(), api.schedulerJobs()]);
      setEvents(nextEvents);
      setTasks(nextTasks);
      // 定时提醒存在 scheduled_jobs 里（和事件、任务不是同一张表），但用户就是在这页找它们
      setReminders(jobs.filter((job) => job.kind === "scheduled_message"));
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 角色名：查不到就说清楚，不显示一串 id */
  function nameOf(characterId: string | null | undefined): string {
    if (characterId === null || characterId === undefined || characterId.length === 0) return "通用（不属于某个角色）";
    return props.characters.find((character) => character.id === characterId)?.name ?? "已删除的角色";
  }

  function matches(characterId: string | null | undefined): boolean {
    if (filter === "") return true;
    if (filter === NO_CHARACTER) return characterId === null || characterId === undefined || characterId.length === 0;
    return characterId === filter;
  }
  /** 按角色分组：角色顺序跟「角色」页一致，通用/已删除的角色放最后 */
  function groupByCharacter<T,>(items: T[], idOf: (item: T) => string | null | undefined): Group<T>[] {
    const groups: Group<T>[] = [];
    if (filter !== "" && filter !== NO_CHARACTER) {
      groups.push({ id: filter, name: nameOf(filter), items: items.filter((item) => idOf(item) === filter) });
      return groups;
    }
    for (const character of props.characters) {
      const own = items.filter((item) => idOf(item) === character.id);
      if (own.length > 0) groups.push({ id: character.id, name: character.name, items: own });
    }
    /** 没挂角色、或者角色已经被删掉的记录：不能凭空消失，得让人看见 */
    const known = new Set(props.characters.map((character) => character.id));
    const generic = items.filter((item) => {
      const id = idOf(item);
      return id === null || id === undefined || id.length === 0;
    });
    const orphaned = items.filter((item) => {
      const id = idOf(item);
      return id !== null && id !== undefined && id.length > 0 && !known.has(id);
    });
    if (filter !== NO_CHARACTER && generic.length > 0) groups.push({ id: null, name: "通用（不属于某个角色）", items: generic });
    if (orphaned.length > 0) groups.push({ id: null, name: "已删除的角色", items: orphaned });
    return groups;
  }

  /** 分组渲染：一个角色一个标题 + 一组卡；空的时候说清楚是"没有"还是"这个角色没有" */
  function renderGroups<T,>(groups: Group<T>[], render: (item: T) => ReactNode, nothing: string): ReactNode {
    const shown = groups.filter((group) => group.items.length > 0);
    if (shown.length === 0) {
      const who = filter === "" ? null : nameOf(filter === NO_CHARACTER ? null : filter);
      const text = nothing.replace(/^还没有/, "");
      return (
        <ul className="cards">
          <li className="empty">{who === null ? nothing : "「" + who + "」还没有" + text}</li>
        </ul>
      );
    }
    return shown.map((group) => (
      <div key={group.name}>
        <h3>
          {group.name}（{group.items.length}）
        </h3>
        <ul className="cards">{group.items.map(render)}</ul>
      </div>
    ));
  }

  async function handleCreate() {
    const characterId = form.characterId.length > 0 ? form.characterId : (props.characters[0]?.id ?? "");
    if (characterId.length === 0 || form.title.trim().length === 0) return;
    try {
      await api.createEvent({
        characterId,
        type: form.type,
        title: form.title.trim(),
        description: form.description.trim(),
        dueAt: form.dueAt.trim().length > 0 ? new Date(form.dueAt).toISOString() : null,
      });
      setForm({ ...form, title: "", description: "", dueAt: "" });
      await refresh();
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  const shownEvents = events.filter((event) => matches(event.characterId));
  const shownTasks = tasks.filter((task) => matches(task.characterId));
  const shownReminders = reminders.filter((job) => matches(job.characterId));  return (
    <section className="panel">
      <h2>事件与任务</h2>
      <p className="hint">这里的事件、任务、定时提醒都属于某个角色：每条都标了是谁的事，也可以只看某一个人。</p>

      <div className="row">
        <label>
          看谁的事
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              // 切到某个角色时，新建事件也默认记在他名下
              if (event.target.value !== "" && event.target.value !== NO_CHARACTER) {
                setForm((previous) => ({ ...previous, characterId: event.target.value }));
              }
            }}
          >
            <option value="">全部角色（事件 {events.length}・任务 {tasks.length}・提醒 {reminders.length}）</option>
            {props.characters.map((character) => {
              const own =
                events.filter((event) => event.characterId === character.id).length +
                tasks.filter((task) => task.characterId === character.id).length +
                reminders.filter((job) => job.characterId === character.id).length;
              return (
                <option key={character.id} value={character.id}>
                  {character.name}（{own}）
                </option>
              );
            })}
            <option value={NO_CHARACTER}>通用（不属于某个角色）</option>
          </select>
        </label>
      </div>

      <h2>事件（{shownEvents.length}）</h2>
      <p className="hint">事件是发生或将要发生的事。承诺与计划到点会派生提醒任务。</p>

      <div className="grid">
        <label>
          这个事件是谁的事
          <select value={form.characterId} onChange={(event) => setForm({ ...form, characterId: event.target.value })}>
            <option value="">（默认第一个角色）</option>
            {props.characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          类型
          <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
            {Object.entries(EVENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="周末一起去书店" />
        </label>
        <label>
          时间（可选）
          <input type="datetime-local" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} />
        </label>
      </div>
      <button disabled={form.title.trim().length === 0} onClick={() => void handleCreate()}>
        创建事件
      </button>      {renderGroups(
        groupByCharacter(shownEvents, (event) => event.characterId),
        (event) => (
          <li key={event.id}>
            <div className="row space-between">
              <strong>{event.title}</strong>
              <span className="score">
                {EVENT_TYPE_LABELS[event.type] ?? event.type} · {STATUS_LABELS[event.status] ?? event.status}
              </span>
            </div>
            <div className="meta">
              <span>属于：{nameOf(event.characterId)}</span>
              {event.dueAt !== null && <span>时间：{event.dueAt.slice(0, 16).replace("T", " ")}</span>}
              <span>重要度 {event.importance.toFixed(2)}</span>
            </div>
            {event.description.length > 0 && <p className="hint">{event.description}</p>}
            <div className="row">
              {(event.status === "planned" || event.status === "active") && (
                <>
                  <button className="ghost" onClick={() => void api.completeEvent(event.id).then(refresh).catch((error: Error) => props.onError(error.message))}>
                    完成
                  </button>
                  <button className="ghost" onClick={() => void api.cancelEvent(event.id).then(refresh).catch((error: Error) => props.onError(error.message))}>
                    取消
                  </button>
                </>
              )}
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm("确定删除事件「" + event.title + "」吗？这个操作不可撤销。"))
                    void api.deleteEvent(event.id).then(refresh).catch((error: Error) => props.onError(error.message));
                }}
              >
                删除
              </button>
            </div>
          </li>
        ),
        "还没有事件。",
      )}

      <h2>任务（{shownTasks.length}）</h2>
      <p className="hint">任务是你或角色需要执行的动作，例如到点主动问候。</p>
      <div className="row">
        <button className="ghost" onClick={() => void api.runTasks().then(refresh).catch((error: Error) => props.onError(error.message))}>
          立即执行到期任务
        </button>
      </div>
      {renderGroups(
        groupByCharacter(shownTasks, (task) => task.characterId),
        (task) => (
          <li key={task.id}>
            <div className="row space-between">
              <strong>{task.payload?.title ?? jobKindLabel(task.kind)}</strong>
              <span className="score">{taskStatusLabel(task.status)}</span>
            </div>
            <div className="meta">
              <span>属于：{nameOf(task.characterId)}</span>
              <span>执行时间：{task.executeAt.slice(0, 16).replace("T", " ")}</span>
              <span>
                尝试 {task.attempts}/{task.maxAttempts}
              </span>
              {task.eventId !== null && <span>来自事件</span>}
            </div>
            {task.lastError !== null && <p className="warn">最近错误：{task.lastError}</p>}
            <div className="row">
              {task.status !== "completed" && (
                <button className="ghost" onClick={() => void api.completeTask(task.id).then(refresh).catch((error: Error) => props.onError(error.message))}>
                  标记完成
                </button>
              )}
              {task.status !== "cancelled" && (
                <button className="ghost" onClick={() => void api.cancelTask(task.id).then(refresh).catch((error: Error) => props.onError(error.message))}>
                  取消
                </button>
              )}
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm("确定删除任务「" + (task.payload?.title ?? jobKindLabel(task.kind)) + "」吗？这个操作不可撤销。"))
                    void api.deleteTask(task.id).then(refresh).catch((error: Error) => props.onError(error.message));
                }}
              >
                删除
              </button>
            </div>
          </li>
        ),
        "还没有任务。",
      )}      <h2>定时提醒（{shownReminders.length}）</h2>
      <p className="hint">
        你让角色到点提醒你的事。到时间角色会用自己的语气把这件事说出来（不是照念这句话），发到你指定的聊天里（网页 / 微信）。
      </p>
      {renderGroups(
        groupByCharacter(shownReminders, (job) => job.characterId),
        (job) => (
          <li key={job.id}>
            <div className="row space-between">
              <strong title={rawValue(reminderText(job))}>{reminderText(job)}</strong>
              <span className={job.enabled ? "ok-text" : "score"}>
                {"● "}
                {jobStatusLabel(job)}
              </span>
            </div>
            <div className="meta">
              <span>属于：{nameOf(job.characterId)}</span>
              <span>{nextRunText(job)}</span>
              <span>上次发送：{formatMoment(job.lastRunAt)}</span>
              <span>发到：{channelLabel(typeof job.payload?.channel === "string" ? job.payload.channel : null)}</span>
            </div>
            <div className="row">
              <button
                className="ghost"
                onClick={() =>
                  void api
                    .setJobEnabled(job.id, !job.enabled)
                    .then(refresh)
                    .catch((error: Error) => props.onError(error.message))
                }
              >
                {job.enabled ? "停用" : "启用"}
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (window.confirm("确定删除这条提醒「" + reminderText(job) + "」吗？删掉之后不会再响。"))
                    void api.deleteJob(job.id).then(refresh).catch((error: Error) => props.onError(error.message));
                }}
              >
                删除
              </button>
              <span className="hint">{job.enabled ? "停用只是暂时不响，删除才是彻底去掉。" : "这条已经停用，不会再响。"}</span>
            </div>
          </li>
        ),
        "还没有定时提醒。在聊天里说「明天中午12点提醒我去开会」就会出现在这里。",
      )}
    </section>
  );
}
