import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { CharacterDto, JobDto, ProactiveDecisionDto, ProactivePolicyDto, SchedulerStatusDto } from "../lib/types.ts";
import {
  blockedReasonLabel,
  decisionLabel,
  formatMoment,
  jobKindHint,
  jobKindLabel,
  jobStatusLabel,
  nextRunText,
  proactiveTriggerLabel,
  rawValue,
  triggerLabel,
} from "../lib/labels.ts";

const AUTONOMY_LABELS: Array<[ProactivePolicyDto["autonomy"], string]> = [
  ["passive", "完全被动（不主动说话）"],
  ["low", "低（每天最多 1 条）"],
  ["normal", "正常"],
  ["high", "高（额度 +1，冷却减半）"],
  ["autonomous", "自主（额度 +2，冷却更短）"],
];

export function ProactivePage(props: {
  characters: CharacterDto[];
  onError: (message: string) => void;
}) {
  const [policy, setPolicy] = useState<ProactivePolicyDto | null>(null);
  const [eligibility, setEligibility] = useState<Array<{ characterId: string; characterName: string; decision: { allowed: boolean; blockedReason: string | null } }>>([]);
  const [decisions, setDecisions] = useState<ProactiveDecisionDto[]>([]);
  const [status, setStatus] = useState<SchedulerStatusDto | null>(null);
  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const refresh = async () => {
    try {
      const [settings, nextDecisions, schedulerStatus, nextJobs] = await Promise.all([
        api.proactiveSettings(),
        api.proactiveDecisions(),
        api.schedulerStatus(),
        api.schedulerJobs(),
      ]);
      setPolicy(settings.policy);
      setEligibility(settings.eligibility);
      setDecisions(nextDecisions);
      setStatus(schedulerStatus);
      setJobs(nextJobs);
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patch(next: Partial<ProactivePolicyDto>) {
    try {
      const result = await api.updateProactiveSettings(next);
      setPolicy(result.policy);
      await refresh();
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  const characterId = props.characters[0]?.id ?? null;

  return (
    <section className="panel">
      <h2>主动消息</h2>
      <p className="hint">角色可以主动找你说话，但会先经过规则判断：静音时段、每日上限、冷却时间与自主等级。</p>

      {policy !== null && (
        <>
          <label className="toggle">
            <input type="checkbox" checked={policy.enabled} onChange={(event) => void patch({ enabled: event.target.checked })} />
            允许角色主动发消息
          </label>

          <div className="grid">
            <label>
              自主等级
              <select value={policy.autonomy} onChange={(event) => void patch({ autonomy: event.target.value as ProactivePolicyDto["autonomy"] })}>
                {AUTONOMY_LABELS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              每天最多主动消息
              <input
                type="number"
                min={0}
                max={20}
                value={policy.dailyLimit}
                onChange={(event) => void patch({ dailyLimit: Number(event.target.value) })}
              />
            </label>
            <label>
              冷却时间（分钟）
              <input
                type="number"
                min={0}
                max={1440}
                value={Math.round(policy.cooldownMs / 60000)}
                onChange={(event) => void patch({ cooldownMs: Number(event.target.value) * 60000 })}
              />
            </label>
            <label>
              多久没聊才算"冷淡期"（小时）
              <input
                type="number"
                min={1}
                max={720}
                value={Math.round(policy.inactivityThresholdMs / 3600000)}
                onChange={(event) => void patch({ inactivityThresholdMs: Number(event.target.value) * 3600000 })}
              />
            </label>
          </div>

          <h3>静音时段</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={policy.quietHours.enabled}
              onChange={(event) => void patch({ quietHours: { ...policy.quietHours, enabled: event.target.checked } })}
            />
            在静音时段不主动打扰
          </label>
          <div className="row">
            <input
              value={policy.quietHours.start}
              onChange={(event) => void patch({ quietHours: { ...policy.quietHours, start: event.target.value } })}
              placeholder="23:00"
            />
            <span className="hint">至</span>
            <input value={policy.quietHours.end} onChange={(event) => void patch({ quietHours: { ...policy.quietHours, end: event.target.value } })} placeholder="08:00" />
          </div>

          <h3>现在能不能主动说话</h3>
          <ul className="cards">
            {eligibility.map((item) => (
              <li key={item.characterId}>
                <div className="row space-between">
                  <span>{item.characterName}</span>
                  <span className={item.decision.allowed ? "ok-text" : "warn"}>
                    {item.decision.allowed ? "可以" : blockedReasonLabel(item.decision.blockedReason)}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          <div className="row">
            <button
              className="ghost"
              disabled={characterId === null}
              onClick={() =>
                void api
                  .proactivePreview(characterId!, "手动预览")
                  .then((result) => {
                    setPreview(result.text ?? "（被拦住：" + blockedReasonLabel(result.decision.blockedReason) + "）");
                    return refresh();
                  })
                  .catch((error: Error) => props.onError(error.message))
              }
            >
              预览一条主动消息（不发送）
            </button>
            <button
              disabled={characterId === null}
              onClick={() =>
                void api
                  .proactiveTrigger(characterId!)
                  .then(() => refresh())
                  .catch((error: Error) => props.onError(error.message))
              }
            >
              立即主动说一句
            </button>
          </div>
          {preview !== null && <pre className="preview-box">{preview}</pre>}
        </>
      )}

      <h2>调度状态</h2>
      <p className="hint">
        这里显示后台有哪些定时工作、它们什么时候跑。所有时间都是本机时间。
      </p>
      {status !== null && (
        <>
          <ul className="cards">
            <li>
              <div className="row space-between">
                <strong>调度器状态</strong>
                <span className={status.runner.running ? "ok-text" : "warn"}>
                  {status.runner.running ? "运行中" : "已停止"}
                </span>
              </div>
              <div className="meta">
                <span>任务总数：{status.jobs}</span>
                <span>已启用：{status.enabled}</span>
                <span>执行失败：{status.failing}</span>
                <span>待执行的工作项：{status.pendingTasks}</span>
                <span>上次检查：{formatMoment(status.runner.lastTickAt)}</span>
              </div>
            </li>
          </ul>

          <h3>接下来会自己跑的任务</h3>
          <ul className="cards">
            {status.nextJobs.map((job) => (
              <li key={job.id}>
                <div className="row space-between">
                  <strong title={rawValue(job.kind)}>{jobKindLabel(job.kind)}</strong>
                  <span className="score">{job.enabled ? "已启用" : "已停用"}</span>
                </div>
                <div className="meta">
                  <span>{triggerLabel(job.triggerType)}</span>
                  <span>{job.enabled ? "下一次执行：" + formatMoment(job.nextRunAt) : "已停用"}</span>
                </div>
              </li>
            ))}
            {status.nextJobs.length === 0 && <li className="empty">暂时没有安排好的任务。</li>}
          </ul>

          <div className="row">
            <button className="ghost" onClick={() => void api.schedulerTick().then(refresh).catch((error: Error) => props.onError(error.message))}>
              立即检查一次
            </button>
            <span className="hint">只是让后台现在检查一遍有没有到点的事，不会立刻把后面的任务全部执行掉。</span>
          </div>
        </>
      )}

      <label className="toggle">
        <input type="checkbox" checked={showAdvanced} onChange={(event) => setShowAdvanced(event.target.checked)} />
        高级：任务与执行记录
      </label>
      {showAdvanced && (
        <>
          <ul className="cards">
            {jobs.map((job) => (
              <li key={job.id}>
                <div className="row space-between">
                  <strong title={jobKindHint(job.kind)}>{jobKindLabel(job.kind)}</strong>
                  <span className={job.enabled && job.status !== "failed" ? "ok-text" : "score"}>
                    {"● "}{jobStatusLabel(job)}
                  </span>
                </div>
                <div className="meta">
                  {jobKindHint(job.kind) !== undefined && <span>{jobKindHint(job.kind)}</span>}
                </div>
                <div className="meta">
                  <span>类型：{triggerLabel(job.triggerType)}</span>
                  <span>{nextRunText(job)}</span>
                  <span>上次执行：{formatMoment(job.lastRunAt)}</span>
                </div>
                <div className="row">
                  <button className="ghost" onClick={() => void api.setJobEnabled(job.id, !job.enabled).then(refresh).catch((error: Error) => props.onError(error.message))}>
                    {job.enabled ? "停用" : "启用"}
                  </button>
                  <button className="ghost" onClick={() => void api.runJobNow(job.id).then(refresh).catch((error: Error) => props.onError(error.message))}>
                    立即执行一次
                  </button>
                  <span className="hint">「立即执行一次」是让你马上测试这条任务，不会改变它原来的时间安排。</span>
                </div>
                <p className="hint" title={rawValue(job.kind)}>
                  开发者信息：任务类型 {rawValue(job.kind) ?? "—"} ・ 触发方式 {rawValue(job.triggerType) ?? "—"} ・ 状态 {rawValue(job.status) ?? "—"}
                </p>
              </li>
            ))}
          </ul>

          <h3>执行记录（为什么发 / 为什么没发）</h3>
          <ul className="cards">
            {decisions.slice(0, 20).map((decision) => (
              <li key={decision.id}>
                <div className="row space-between">
                  <span>{decision.triggerReason}</span>
                  <span className={decision.decision === "sent" ? "ok-text" : "warn"}>
                    {decision.decision === "sent" ? decisionLabel(decision.decision) : decision.decision === "blocked" || decision.decision === "skipped" ? blockedReasonLabel(decision.blockedReason) : decisionLabel(decision.decision)}
                  </span>
                </div>
                <div className="meta">
                  <span>{proactiveTriggerLabel(decision.triggerKind)}</span>
                  {decision.model !== null && <span>{decision.model}</span>}
                  <span>{decision.createdAt.slice(0, 16).replace("T", " ")}</span>
                </div>
              </li>
            ))}
            {decisions.length === 0 && <li className="empty">还没有决策记录。</li>}
          </ul>
        </>
      )}
    </section>
  );
}