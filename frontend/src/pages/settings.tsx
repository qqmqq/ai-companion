import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { DsFreeLoginPanel } from "./ds-free-login.tsx";
import type { ProviderDto, RoutingItemDto, UsageSummaryDto } from "../lib/types.ts";
import {
  initialModelValue,
  isKnownChoice,
  modelAfterProviderChange,
  normalizeModelChoices,
  resolveModelMode,
  toRouteModel,
  type ModelChoice,
  type ModelInputMode,
} from "../lib/model-choices.ts";

const TASK_LABELS: Record<string, string> = {
  chat: "日常聊天",
  memory_extraction: "记忆抽取",
  summarization: "对话摘要",
  context_compression: "上下文压缩",
  emotion_analysis: "情绪分析",
  character_draft: "角色设定生成（角色工坊）",
  reasoning: "复杂推理",
  agent: "工具/代理",
  proactive: "主动消息",
  translation: "翻译",
  embedding: "向量化",
};

/** select 里代表"我要手填"的哨兵值：不可能是真实模型名 */
const MANUAL_SENTINEL = "__companion_manual_model__";

/**
 * 模型选择控件：有候选就用真正的 <select>（点一下就能选中），没有候选或用户选择手填就用输入框。
 * 手填永远可用 —— 模型发现失败也不能挡住用户填自己的模型名。
 */
function ModelPicker(props: {
  choices: ModelChoice[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [manualOverride, setManualOverride] = useState(false);
  const mode: ModelInputMode = manualOverride ? "manual" : resolveModelMode(props.choices, props.value);
  const inList = isKnownChoice(props.choices, props.value);

  if (mode === "list") {
    return (
      <select
        className="model-select"
        disabled={props.disabled ?? false}
        value={props.value}
        onChange={(event) => {
          if (event.target.value === MANUAL_SENTINEL) {
            setManualOverride(true);
            return;
          }
          props.onChange(event.target.value);
        }}
      >
        {props.value.trim().length > 0 && !inList && <option value={props.value}>{props.value}（当前值）</option>}
        {props.value.trim().length === 0 && <option value="">（用该 Provider 的默认模型）</option>}
        {props.choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.name === choice.id ? choice.id : choice.name + "（" + choice.id + "）"}
          </option>
        ))}
        <option value={MANUAL_SENTINEL}>手填模型名…</option>
      </select>
    );
  }

  return (
    <span className="row">
      <input
        disabled={props.disabled ?? false}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
      />
      {props.choices.length > 0 && (
        <button
          className="ghost"
          onClick={() => {
            setManualOverride(false);
            if (!isKnownChoice(props.choices, props.value)) props.onChange(props.choices[0]!.id);
          }}
        >
          从列表选择
        </button>
      )}
    </span>
  );
}

/**
 * 一条"任务用哪个模型"的编辑器：Provider 与 Model 是两个独立选择。
 * 选中后立刻在界面上显示"当前模型"，点「应用」才写入后端。
 */
function RouteRow(props: {
  item: RoutingItemDto;
  providers: ProviderDto[];
  models: Record<string, ModelChoice[]>;
  onRequestModels: (providerId: string) => void;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [providerId, setProviderId] = useState<string>(
    props.item.configured?.providerId ?? props.item.resolved?.providerId ?? props.providers[0]?.id ?? "",
  );
  const [model, setModel] = useState<string>(
    initialModelValue({ configured: props.item.configured?.model ?? null, resolved: props.item.resolved?.model ?? null }),
  );
  const [busy, setBusy] = useState(false);
  const choices = props.models[providerId] ?? [];

  // 第一次渲染就把这个 Provider 的模型列表取回来，用户不必先点「刷新模型列表」
  useEffect(() => {
    props.onRequestModels(providerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  /** 换 Provider：上一个 Provider 的模型名不允许残留 */
  function changeProvider(nextProviderId: string) {
    setProviderId(nextProviderId);
    const provider = props.providers.find((entry) => entry.id === nextProviderId) ?? null;
    setModel(modelAfterProviderChange(props.models[nextProviderId] ?? [], provider?.defaultModel ?? ""));
  }

  async function save() {
    setBusy(true);
    try {
      await api.setRoute(props.item.taskType, providerId, toRouteModel(model));
      await props.onSaved();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li>
      <div className="row space-between">
        <strong>{TASK_LABELS[props.item.taskType] ?? props.item.taskType}</strong>
        <span className="score">
          {props.item.resolved === null
            ? "实际使用：还没有可用的模型"
            : "实际使用：" + props.item.resolved.providerId + " / " + props.item.resolved.model}
        </span>
      </div>
      <div className="row">
        <select value={providerId} onChange={(event) => changeProvider(event.target.value)}>
          {props.providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName}（{provider.kind}）
            </option>
          ))}
        </select>
        <ModelPicker
          choices={choices}
          value={model}
          onChange={setModel}
          placeholder="模型名，例如 gpt-5-mini / qwen-plus / qwen3"
        />
        <button aria-busy={busy} disabled={busy} onClick={() => void save()}>
          {busy ? "保存中…" : "应用"}
        </button>
      </div>
      <p className="hint">当前模型：{model.trim().length === 0 ? "（跟随该 Provider 的默认模型）" : model}</p>
      <p className="hint">
        {choices.length > 0
          ? "该 Provider 报告了 " + String(choices.length) + " 个模型，可直接从下拉里选；也可以选「手填模型名」自己填。"
          : "没有取到模型列表（不影响手填）：点上面的「刷新模型列表」，或直接在这里输入模型名。"}
      </p>
    </li>
  );
}
export function SettingsPage(props: { onError: (message: string) => void }) {
  const inFlight = useRef<Set<string>>(new Set());
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [routing, setRouting] = useState<RoutingItemDto[]>([]);
  const [usage, setUsage] = useState<{ summary: UsageSummaryDto[] } | null>(null);
  const [form, setForm] = useState({ id: "", kind: "openai-compatible", displayName: "", baseUrl: "", defaultModel: "", apiKey: "" });
  const [testResult, setTestResult] = useState<{ id: string; ok: boolean; message: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  /** providerId -> 上游报告的模型候选（发现失败时是空数组，用户仍然可以手填模型名） */
  const [models, setModels] = useState<Record<string, ModelChoice[]>>({});
  /** providerId -> 发现失败原因（只为提示，不影响手填） */
  const [modelsError, setModelsError] = useState<Record<string, string>>({});
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);

  /**
   * 三段各自兜错，不用 Promise.all：
   * 以前任何一段失败（比如路由接口报错）整次刷新就作废，删掉的 Provider 会一直留在页面上，
   * 必须手动刷新页面才消失 —— 真实踩过。
   */
  const refresh = async () => {
    try {
      setProviders(await api.providers());
    } catch (error) {
      props.onError((error as Error).message);
    }
    try {
      setRouting(await api.routing());
    } catch (error) {
      props.onError((error as Error).message);
    }
    try {
      setUsage({ summary: (await api.usage()).summary });
    } catch (error) {
      props.onError((error as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 取一个 Provider 的模型列表（GET /v1/models 或 /api/tags）。
   * - 幂等：已经取过就不再重复请求（除非 force）
   * - 失败只记录原因，**不**清空用户的选择，也不禁用输入
   */
  async function loadModelsFor(providerId: string, force = false): Promise<void> {
    if (!force && (models[providerId] !== undefined || inFlight.current.has(providerId))) return;
    inFlight.current.add(providerId);
    try {
      const result = await api.testProvider(providerId);
      const choices = normalizeModelChoices(result.models);
      setModels((current) => ({ ...current, [providerId]: choices }));
      setModelsError((current) => {
        const next = { ...current };
        if (result.ok) delete next[providerId];
        else next[providerId] = result.error?.message ?? "获取失败";
        return next;
      });
    } catch (error) {
      setModels((current) => ({ ...current, [providerId]: [] }));
      setModelsError((current) => ({ ...current, [providerId]: (error as Error).message }));
    } finally {
      inFlight.current.delete(providerId);
    }
  }

  /** 「刷新模型列表」：对所有 Provider 强制重新拉一次；用户已选的模型不受影响 */
  async function discoverModels() {
    setDiscovering(true);
    try {
      for (const provider of providers) {
        await loadModelsFor(provider.id, true);
      }
      setDiscoverNote("模型列表已更新（各任务上已选的模型不会被改动）。");
    } finally {
      setDiscovering(false);
    }
  }

  /** 编辑已有 Provider：预填表单后保存会更新同一条记录（不会产生重复 Provider） */
  function editProvider(provider: ProviderDto) {
    setForm({
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
      apiKey: "",
    });
  }

  async function handleSave() {
    try {
      await api.upsertProvider({
        ...(form.id.trim().length === 0 ? {} : { id: form.id.trim() }),
        kind: form.kind,
        displayName: form.displayName.trim() || form.kind,
        baseUrl: form.baseUrl.trim(),
        defaultModel: form.defaultModel.trim(),
        requiresCredential: form.kind !== "ollama",
        ...(form.apiKey.trim().length === 0 ? {} : { apiKey: form.apiKey.trim() }),
      });
      setForm({ ...form, apiKey: "" });
      await refresh();
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  return (
    <section className="panel">
      <h2>模型设置</h2>
      <p className="hint">API Key 只保存在本机加密存储中，界面永远不会显示明文。</p>

      <p className="hint">
        想省钱可以把请求转到自建的 DeepSeek 网页反代 —— 那是开源项目
        <a href="https://github.com/NIyueeE/ds-free-api" target="_blank" rel="noreferrer"> ds-free-api </a>
        （GPL-3.0，本机默认 <code>http://127.0.0.1:22217</code>），本项目只调用它的接口。
        下面那个「接入助手」会开真实网页自动取到所需信息、自动启动它、并把模型加进「已配置的模型」，不用你手填任何连接参数。
      </p>

      <div className="grid">
        <label>
          类型
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}>
            <option value="openai-compatible">OpenAI 兼容（含 OpenRouter / llama.cpp / vLLM）</option>
            <option value="ollama">Ollama（本地）</option>
            <option value="echo">内置占位模型（离线）</option>
          </select>
        </label>
        <label>
          名称
          <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder="我的模型" />
        </label>
        <label>
          Base URL
          <input
            value={form.baseUrl}
            onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            placeholder={form.kind === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com"}
          />
        </label>
        <label>
          模型
          <ModelPicker
            choices={form.id.trim().length === 0 ? [] : (models[form.id.trim()] ?? [])}
            value={form.defaultModel}
            onChange={(value) => setForm({ ...form, defaultModel: value })}
            placeholder="gpt-5-mini / qwen-plus / qwen3:8b"
          />
        </label>
        <label>
          API Key（可留空）
          <input
            type="password"
            value={form.apiKey}
            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            placeholder="sk-..."
            autoComplete="off"
          />
        </label>
      </div>
      <button disabled={form.baseUrl.trim().length === 0 || form.defaultModel.trim().length === 0} onClick={() => void handleSave()}>
        保存
      </button>

      <DsFreeLoginPanel onError={props.onError} onApplied={() => void refresh()} />

      <h2>对话提示词</h2>
      <p className="hint">
        已经挪到「角色」页：在那里可以给<strong>每个角色</strong>写一份自己的要求（改完下一句就生效），
        也可以设一份所有角色通用的默认——角色没写自己的那份时用默认。
      </p>

      <h2>已配置的模型</h2>
      <ul className="cards">
        {providers.map((provider) => (
          <li key={provider.id}>
            <div className="row space-between">
              <strong>{provider.displayName}</strong>
              <span className="score">{provider.kind}</span>
            </div>
            <div className="meta">
              <span>{provider.baseUrl}</span>
              <span>默认模型：{provider.defaultModel}</span>
              <span>{provider.requiresCredential ? (provider.hasCredential ? "已配置密钥" : "缺少密钥") : "无需密钥"}</span>
              {!provider.enabled && <span className="warn">已停用</span>}
            </div>
            {(!provider.enabled || (provider.requiresCredential && !provider.hasCredential)) && (
              <p className="warn">
                {provider.requiresCredential && !provider.hasCredential
                  ? "这条还没有密钥，现在不会被用来干活：在「接入助手」里点一次「一键写入」，或编辑它填上 API Key。"
                  : "这条已停用，不会参与任何调用：编辑它保存一次即可重新启用。"}
              </p>
            )}
            {models[provider.id] !== undefined && models[provider.id]!.length > 0 && (
              <div className="meta">
                <span>
                  可用模型：{models[provider.id]!.slice(0, 8).map((choice) => choice.id).join("、")}
                  {models[provider.id]!.length > 8 ? " 等 " + String(models[provider.id]!.length) + " 个" : ""}
                </span>
              </div>
            )}
            {modelsError[provider.id] !== undefined && (
              <div className="meta">
                <span className="warn">模型列表获取失败：{modelsError[provider.id]}（不影响手填模型名）</span>
              </div>
            )}
            <div className="row">
              <button
                className="ghost"
                onClick={() =>
                  void api
                    .testProvider(provider.id)
                    .then((result) => {
                      const choices = normalizeModelChoices(result.models);
                      setModels((current) => ({ ...current, [provider.id]: choices }));
                      setModelsError((current) => {
                        const next = { ...current };
                        if (result.ok) delete next[provider.id];
                        else next[provider.id] = result.error?.message ?? "获取失败";
                        return next;
                      });
                      setTestResult({ id: provider.id, ok: result.ok, message: result.ok ? "可用，" + String(choices.length) + " 个模型" : "失败：" + String(result.error?.kind ?? "") + " " + (result.error?.message ?? "") });
                    })
                    .catch((error: Error) => props.onError(error.message))
                }
              >
                测试连接
              </button>
              <button className="ghost" onClick={() => editProvider(provider)}>
                编辑
              </button>
              <button className="danger" onClick={() => void api.deleteProvider(provider.id).then(refresh).catch((error: Error) => props.onError(error.message))}>
                删除
              </button>
            </div>
            {testResult?.id === provider.id && <p className={testResult.ok ? "ok-text" : "warn"}>{testResult.message}</p>}
          </li>
        ))}
      </ul>

      <h2>任务用哪个模型</h2>
      <p className="hint">日常聊天可以用普通模型，记忆抽取与摘要用便宜的模型，重活留给强模型。Provider 与 Model 分开选，Model 也可以直接手填。</p>
      {/* 一个能用的模型都没有时，把原因明说，而不是让整页报错 */}
      {routing.some((item) => item.resolved === null) && (
        <p className="warn">
          {routing.find((item) => item.unavailableReason !== null && item.unavailableReason !== undefined)?.unavailableReason ??
            "还没有可用的模型：先在下面加一个 Provider。"}
        </p>
      )}
      <div className="row">
        <button className="ghost" disabled={discovering || providers.length === 0} onClick={() => void discoverModels()}>
          {discovering ? "获取中…" : "刷新模型列表"}
        </button>
        {discoverNote !== null && <span className="hint">{discoverNote}</span>}
      </div>
      <ul className="cards">
        {routing.map((item) => (
          <RouteRow
            key={item.taskType}
            item={item}
            providers={providers}
            models={models}
            onRequestModels={(providerId) => void loadModelsFor(providerId)}
            onSaved={refresh}
            onError={props.onError}
          />
        ))}
      </ul>

      <label className="toggle">
        <input type="checkbox" checked={showAdvanced} onChange={(event) => setShowAdvanced(event.target.checked)} />
        高级：用量与成本
      </label>
      {showAdvanced && usage !== null && (
        <table className="usage">
          <thead>
            <tr>
              <th>任务</th>
              <th>调用</th>
              <th>失败</th>
              <th>输入 tokens</th>
              <th>输出 tokens</th>
              <th>估算成本</th>
              <th>平均延迟</th>
            </tr>
          </thead>
          <tbody>
            {usage.summary.map((entry) => (
              <tr key={entry.taskType}>
                <td>{TASK_LABELS[entry.taskType] ?? entry.taskType}</td>
                <td>{entry.calls}</td>
                <td>{entry.failures}</td>
                <td>{entry.inputTokens}</td>
                <td>{entry.outputTokens}</td>
                <td>{entry.estimatedCost === null ? "—" : `$${entry.estimatedCost.toFixed(4)}`}</td>
                <td>{entry.avgLatencyMs} ms</td>
              </tr>
            ))}
            {usage.summary.length === 0 && (
              <tr>
                <td colSpan={7}>还没有调用记录。</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}
