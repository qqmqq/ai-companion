import { useEffect, useRef, useState } from "react";
import { api, type CharacterDefinitionInput } from "../lib/api.ts";
import type { CharacterDto } from "../lib/types.ts";

/** 头像上限 8 MiB（后端同值再验一遍） */
const AVATAR_MAX_BYTES = 8 * 1024 * 1024;

const EMPTY_FORM: CharacterDefinitionInput = {
  name: "",
  description: "",
  personality: "",
  scenario: "",
  systemPrompt: "",
  firstMessage: "",
};

/** 读成 data URL 再切出 base64：大图也不会撑爆调用栈 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("读取文件失败"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

/** 新建/编辑共用一个表单：字段就是本程序的角色模型本身 */
function CharacterForm(props: {
  initial: CharacterDefinitionInput;
  submitLabel: string;
  busy: boolean;
  onSubmit: (input: CharacterDefinitionInput) => Promise<void>;
  onCancel: () => void;
  /**
   * 用户手改字段时把最新定义报给上层。
   * 工坊需要它：否则上层手里还是"补全那一刻"的旧值，
   * 用户改完再让 AI 改，提交的却是没改过的那份。
   */
  onChange?: (input: CharacterDefinitionInput) => void;
}) {
  const [draft, setDraft] = useState<CharacterDefinitionInput>(props.initial);
  /** 名字为空是唯一会挡住提交的规则：先让人填过再报错，别一打开就一片红 */
  const [nameTouched, setNameTouched] = useState(false);
  const nameMissing = draft.name.trim().length === 0;
  const update = (next: CharacterDefinitionInput) => {
    setDraft(next);
    props.onChange?.(next);
  };

  const field = (label: string, key: keyof CharacterDefinitionInput, rows = 2, hint?: string) => (
    <label className="field">
      <span className="hint">{hint === undefined ? label : label + "（" + hint + "）"}</span>
      <textarea rows={rows} value={draft[key]} onChange={(event) => update({ ...draft, [key]: event.target.value })} />
    </label>
  );

  return (
    <div className="editor">
      <label className="field">
        <span className="hint">角色名称</span>
        <input
          value={draft.name}
          onChange={(event) => update({ ...draft, name: event.target.value })}
          onBlur={() => setNameTouched(true)}
          aria-invalid={nameTouched && nameMissing}
          aria-describedby={nameTouched && nameMissing ? "character-name-error" : undefined}
          placeholder="例如：Aria"
        />
        {nameTouched && nameMissing && (
          <p className="field-error" id="character-name-error">
            角色名称不能为空：先给它起个名字。
          </p>
        )}
      </label>
      {field("描述 / 身份", "description", 3, "这个角色是谁")}
      {field("性格", "personality", 2, "说话与反应的方式")}
      {field("背景 / 场景", "scenario", 2, "故事发生在哪里")}
      {field("System Prompt", "systemPrompt", 3, "可选：给模型的额外指令")}
      {field("开场白", "firstMessage", 3, "新会话里角色的第一句话")}
      <div className="row">
        <button
          aria-busy={props.busy}
          disabled={props.busy || draft.name.trim().length === 0}
          onClick={() => void props.onSubmit({ ...draft, name: draft.name.trim() })}
        >
          {props.busy ? "保存中…" : props.submitLabel}
        </button>
        <button className="ghost" onClick={props.onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/** 头像上传：只负责选文件与校验，真正的二进制进 MediaStorage 由后端做 */
function AvatarPicker(props: {
  character: CharacterDto;
  busy: boolean;
  onUploaded: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function pick(file: File | null) {
    if (file === null) return;
    if (file.size === 0) {
      props.onError("头像文件是空的");
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      props.onError("文件过大：头像最大 8 MiB");
      return;
    }
    if (file.type !== "" && !file.type.startsWith("image/")) {
      props.onError("请选择图片文件（PNG / JPEG / WebP）");
      return;
    }
    try {
      const base64 = await readAsBase64(file);
      await api.setCharacterAvatar(props.character.id, file.name, base64);
      await props.onUploaded();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      if (inputRef.current !== null) inputRef.current.value = "";
    }
  }

  async function clear() {
    try {
      await api.clearCharacterAvatar(props.character.id);
      await props.onUploaded();
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  return (
    <div className="row">
      <input ref={inputRef} type="file" accept="image/*" disabled={props.busy} onChange={(event) => void pick(event.target.files?.[0] ?? null)} />
      {props.character.avatarMediaId !== null && (
        <button className="ghost" disabled={props.busy} onClick={() => void clear()}>
          删除头像
        </button>
      )}
    </div>
  );
}

/**
 * 对话提示词（这个角色专属）。
 *
 * 跟角色走，但**不进角色版本**：角色定义是带版本的，已有会话冻结在创建时那一版，
 * 写进定义里就会出现「改完下一句没反应」——所以它存在设置表里，改完下一句就生效。
 * 留空 = 不留覆盖，用「默认对话提示词」。
 */
function CharacterPromptEditor(props: { character: CharacterDto; onError: (message: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  /** 全局默认那份：用来告诉用户"留空会发生什么" */
  const [fallback, setFallback] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setText(null);
    setNote(null);
    void api
      .characterPrompt(props.character.id)
      .then((state) => {
        if (!alive) return;
        setText(state.prompt);
        setFallback(state.fallback);
      })
      .catch((error: Error) => {
        if (alive) props.onError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [props.character.id]);

  async function save(next: string) {
    setBusy(true);
    try {
      const saved = await api.saveCharacterPrompt(props.character.id, next);
      setText(saved.prompt);
      setNote(saved.prompt.length === 0 ? "已清空，改回用默认。" : "已保存，后一句起生效。");
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const value = text ?? "";
  return (
    <div className="prompt-editor">
      <label className="field">
        <span className="hint">对话提示词（只对「{props.character.name}」生效，改完下一句就生效）</span>
        <textarea
          value={value}
          rows={4}
          maxLength={4000}
          disabled={text === null}
          placeholder={fallback.length > 0 ? "留空 = 用默认：" + fallback : "例如：说话短一点，别用感叹号；称呼我「你」就好。"}
          onChange={(event) => {
            setText(event.target.value);
            setNote(null);
          }}
        />
      </label>
      <div className="row">
        <button aria-busy={busy} disabled={busy || text === null} onClick={() => void save(value)}>
          {busy ? "保存中…" : "保存对话提示词"}
        </button>
        <button className="ghost" disabled={busy || value.length === 0} onClick={() => void save("")}>
          清空，改回用默认
        </button>
        {note !== null && <span className="hint">{note}</span>}
        {value.length === 0 && fallback.length > 0 && <span className="hint">当前用的是默认：{fallback}</span>}
      </div>
    </div>
  );
}

/** 所有角色通用的默认对话提示词（原来在「模型设置」里，现在搬到角色页） */
function DefaultPromptEditor(props: { onError: (message: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .promptSettings()
      .then((state) => {
        if (alive) setText(state.custom);
      })
      .catch((error: Error) => {
        if (alive) props.onError(error.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save(next: string) {
    try {
      const saved = await api.savePromptSettings(next);
      setText(saved.custom);
      setNote(saved.custom.length === 0 ? "已清空。" : "已保存，下一句起生效。");
    } catch (error) {
      props.onError((error as Error).message);
    }
  }

  return (
    <details className="prompt-default">
      <summary>默认对话提示词（所有角色通用）</summary>
      <p className="hint">
        这里写的要求会追加进每次对话的「系统约束」那一段。<strong>角色自己写了就不再用它</strong>；角色没写自己那份时，用这里的内容。
      </p>
      <textarea
        value={text ?? ""}
        rows={3}
        maxLength={4000}
        disabled={text === null}
        placeholder="例如：说话短一点，别用感叹号；称呼我「你」就好，不要叫先生女士。"
        onChange={(event) => {
          setText(event.target.value);
          setNote(null);
        }}
      />
      <div className="row">
        <button disabled={text === null} onClick={() => void save(text ?? "")}>
          保存默认
        </button>
        <button className="ghost" disabled={text === null || (text ?? "").length === 0} onClick={() => void save("")}>
          清空
        </button>
        {note !== null && <span className="hint">{note}</span>}
      </div>
    </details>
  );
}

/** 接口层报的是字段路径（ideas / definition.name），界面上要说人话 */
const STUDIO_FIELD_LABELS: Record<string, string> = {
  ideas: "设想",
  instruction: "修改要求",
  history: "对话记录",
  "definition.name": "角色名称",
  "definition.description": "角色描述",
  "definition.personality": "性格",
  "definition.scenario": "背景",
  "definition.systemPrompt": "System Prompt",
  "definition.firstMessage": "开场白",
};

export function friendlyStudioError(message: string): string {
  return Object.entries(STUDIO_FIELD_LABELS).reduce((text, [path, label]) => text.split(path + " ").join(label), message);
}

/**
 * 角色工坊：设想 → AI 补全 → 看着改 → 确认才落库。
 *
 * 这里刻意**不**在每次 AI 回复时保存：AI 提出的只是候选设定，
 * 用户按了确认键才会变成新的 Character Version。旧会话继续用它创建时冻结的版本。
 */
function CharacterStudio(props: {
  characters: CharacterDto[];
  busy: boolean;
  onSaved: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [targetId, setTargetId] = useState("");
  const [ideas, setIdeas] = useState("");
  const [draft, setDraft] = useState<CharacterDefinitionInput | null>(null);
  const [draftKey, setDraftKey] = useState(0);
  const [turns, setTurns] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [changes, setChanges] = useState<Array<{ label: string; before: string; after: string }>>([]);
  const [instruction, setInstruction] = useState("");
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const current = targetId === "" ? null : (props.characters.find((item) => item.id === targetId) ?? null);

  function show(result: { definition: CharacterDefinitionInput; reply: string; changes: Array<{ label: string; before: string; after: string }> }) {
    setDraft(result.definition);
    setDraftKey((value) => value + 1);
    setChanges(result.changes);
    setTurns((history) => [...history, { role: "assistant", text: result.reply.length > 0 ? result.reply : "（这次没有改动）" }]);
  }

  async function run(action: () => Promise<void>) {
    setWorking(true);
    try {
      await action();
    } catch (error) {
      // 后端会说清"哪个字段、为什么"，但字段名是代码路径，这里翻成用户看得懂的说法
      props.onError(friendlyStudioError((error as Error).message));
    } finally {
      setWorking(false);
    }
  }

  function pickTarget(id: string) {
    setTargetId(id);
    setTurns([]);
    setChanges([]);
    setSaved(null);
    setDraft(null);
    const character = id === "" ? null : (props.characters.find((item) => item.id === id) ?? null);
    if (character !== null) {
      // 从"他现在的样子"开始改，而不是从空开始
      setDraft(character.definition);
      setDraftKey((value) => value + 1);
    }
  }

  return (
    <div className="editor">
      <h3>角色工坊：写几句设想，剩下的交给 AI</h3>
      <p className="hint">
        你只要说个大概（"一个开旧书店的人，说话很少"），AI 会补成完整设定；不满意就接着用大白话提要求（"性格再冷一点""加入嘴硬属性""把背景改成现代都市"）。
        AI 每次给的都只是候选，按「确认」才会存成新版本；已有会话继续用它们原来的版本。
      </p>

      <label className="field">
        <span className="hint">保存到哪里</span>
        <select value={targetId} onChange={(event) => pickTarget(event.target.value)}>
          <option value="">存成新角色</option>
          {props.characters.map((character) => (
            <option key={character.id} value={character.id}>
              改「{character.name}」（现在是第 {character.versionCount} 版）
            </option>
          ))}
        </select>
      </label>

      {current !== null && draft !== null && (
        <p className="hint">下面是他现在的设定，你可以直接改文字，也可以让 AI 改。</p>
      )}

      {draft === null ? (
        <>
          <label className="field">
            <span className="hint">你想要的角色（随便写）</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={ideas}
              onChange={(event) => setIdeas(event.target.value)}
              placeholder="例如：一个开旧书店的人，说话很少，但对书的事很固执"
            />
            <span className="hint">
              {ideas.trim().length} / 2000 字（不用写得很细，AI 会补全）
            </span>
          </label>
          <div className="row">
            <button aria-busy={working} disabled={working || props.busy || ideas.trim().length === 0} onClick={() => run(async () => {
              const result = await api.draftCharacter({ ideas: ideas.trim() });
              setTurns([{ role: "user", text: ideas.trim() }]);
              show(result);
            })}>
              {working ? "AI 正在补全…" : "让 AI 补全"}
            </button>
          </div>
        </>
      ) : (
        <>
          {turns.length > 0 && (
            <ul className="cards">
              {turns.slice(-6).map((turn, index) => (
                <li key={String(index)}>
                  <div className="meta">
                    <span>{turn.role === "user" ? "你" : "AI"}</span>
                  </div>
                  <p>{turn.text}</p>
                </li>
              ))}
            </ul>
          )}

          {changes.length > 0 && (
            <>
              <h3>这次改了什么</h3>
              <ul className="cards">
                {changes.map((change) => (
                  <li key={change.label}>
                    <div className="row space-between">
                      <strong>{change.label}</strong>
                    </div>
                    <div className="meta">
                      <span>改前：{change.before.length > 60 ? change.before.slice(0, 60) + "…" : change.before}</span>
                    </div>
                    <div className="meta">
                      <span>改后：{change.after.length > 60 ? change.after.slice(0, 60) + "…" : change.after}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          {draft.name.trim().length === 0 && <p className="warn">角色名称不能为空，先给它起个名字再让 AI 改。</p>}
          <div className="row">
            <input
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              maxLength={1000}
              placeholder="接着说要求，例如：性格再冷一点"
              onKeyDown={(event) => {
                if (event.key === "Enter" && instruction.trim().length > 0) {
                  const text = instruction.trim();
                  setInstruction("");
                  setTurns((history) => [...history, { role: "user", text }]);
                  void run(async () => {
                    show(await api.reviseCharacter({ definition: draft, instruction: text, history: turns }));
                  });
                }
              }}
            />
            <button
              aria-busy={working}
              disabled={working || instruction.trim().length === 0 || draft.name.trim().length === 0}
              onClick={() => {
                const text = instruction.trim();
                setInstruction("");
                setTurns((history) => [...history, { role: "user", text }]);
                void run(async () => {
                  show(await api.reviseCharacter({ definition: draft, instruction: text, history: turns }));
                });
              }}
            >
              {working ? "AI 正在改…" : "让 AI 改"}
            </button>
            <button className="ghost" onClick={() => { setDraft(null); setTurns([]); setChanges([]); setSaved(null); }}>
              重新开始
            </button>
          </div>

          <CharacterForm
            key={draftKey}
            initial={draft}
            submitLabel={targetId === "" ? "确认，存成新角色" : "确认，保存为新版本"}
            busy={working || props.busy}
            onChange={setDraft}
            onCancel={() => { setDraft(null); setTurns([]); setChanges([]); }}
            onSubmit={(input) =>
              run(async () => {
                if (targetId === "") {
                  await api.createCharacter(input);
                  setSaved("已存成新角色。");
                } else {
                  await api.updateCharacter(targetId, input);
                  setSaved("已保存为新版本。这个角色已有的会话继续用旧版本，想用新版请开一个新会话。");
                }
                await props.onSaved();
              })
            }
          />
          {saved !== null && <p className="hint">{saved}</p>}
        </>
      )}
    </div>
  );
}

export function CharactersPage(props: {
  characters: CharacterDto[];
  onChanged: () => Promise<void>;
  onStartChat: (character: CharacterDto, options?: { newSession?: boolean }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [studio, setStudio] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      props.onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <h2>角色</h2>
      <p className="hint">
        角色属于本程序自己的模型：名称 / 描述 / 性格 / 背景 / System Prompt / 开场白 / 头像。编辑会生成新版本，已有会话继续用旧版本。
        对话提示词在下面每个角色的「编辑」里改——<strong>改完下一句就生效</strong>，不会因为版本冻结而失效。
      </p>
      <div className="row">
        <button onClick={() => { setCreating(!creating); setStudio(false); }}>{creating ? "收起" : "新建角色"}</button>
        <button className="ghost" onClick={() => { setStudio(!studio); setCreating(false); }}>
          {studio ? "收起角色工坊" : "角色工坊：用一段话创建 / 用对话改"}
        </button>
      </div>
      {creating && (
        <CharacterForm
          initial={EMPTY_FORM}
          submitLabel="创建角色"
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={(input) =>
            run(async () => {
              await api.createCharacter(input);
              setCreating(false);
              await props.onChanged();
            })
          }
        />
      )}

      {studio && (
        <CharacterStudio characters={props.characters} busy={busy} onSaved={props.onChanged} onError={props.onError} />
      )}

      <h2>我的角色（{props.characters.length}）</h2>
      <ul className="cards">
        {props.characters.map((character) => (
          <li key={character.id}>
            {character.avatarMediaId !== null ? (
              <img className="avatar" src={api.characterAvatarUrl(character.id)} alt={character.name} />
            ) : (
              <span className="avatar avatar-empty">无头像</span>
            )}
            <strong>{character.name}</strong>
            <div className="meta">
              <span>版本：第 {character.versionCount} 版</span>
              <span>情绪：{character.state.emotion.primary}</span>
              <span>正在：{character.state.activity.label}</span>
            </div>
            <p>{character.definition.description || "（无描述）"}</p>
            <div className="row">
              <button onClick={() => void props.onStartChat(character)}>开始聊天</button>
              {character.versionCount > 1 && (
                <button className="ghost" onClick={() => void props.onStartChat(character, { newSession: true })}>
                  用最新版本开新会话
                </button>
              )}
              <button className="ghost" onClick={() => setEditing(editing === character.id ? null : character.id)}>
                {editing === character.id ? "收起编辑" : "编辑"}
              </button>
              <button className="ghost" onClick={() => void run(async () => { await api.duplicateCharacter(character.id); await props.onChanged(); })}>
                复制
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (!window.confirm("删除角色「" + character.name + "」？这个操作不可撤销。")) return;
                  void run(async () => {
                    await api.deleteCharacter(character.id);
                    setEditing(null);
                    await props.onChanged();
                  });
                }}
              >
                删除
              </button>
            </div>
            {editing === character.id && (
              <div>
                <CharacterForm
                  initial={character.definition}
                  submitLabel="保存（生成新版本）"
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={(input) =>
                    run(async () => {
                      await api.updateCharacter(character.id, input);
                      await props.onChanged();
                    })
                  }
                />
                <AvatarPicker character={character} busy={busy} onUploaded={props.onChanged} onError={props.onError} />
                <CharacterPromptEditor key={character.id} character={character} onError={props.onError} />
              </div>
            )}
          </li>
        ))}
        {props.characters.length === 0 && <li className="empty">还没有角色，点上面的「新建角色」开始。</li>}
      </ul>

      {/* 全局那份放最后：这里主要是按角色改，通用的默认是兜底 */}
      <DefaultPromptEditor onError={props.onError} />
    </section>
  );
}
