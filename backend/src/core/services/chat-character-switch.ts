import type { CharacterRecord } from "../model/character.ts";
import type { ChannelKind } from "../model/channel.ts";
import type { CharacterId, UserId } from "../model/ids.ts";
import { notFound } from "../model/errors.ts";
import type { CharacterRepository, SettingsRepository } from "../ports/repositories.ts";
import type { Clock } from "../ports/clock.ts";
import type { Logger } from "../ports/logger.ts";
import type { ConversationService } from "./conversation-service.ts";

/**
 * 渠道聊天里「现在在跟哪个角色聊」。
 *
 * 为什么需要它：入站消息只带渠道层的会话引用（例如微信里就是对方的 id），
 * 系统必须知道这条消息该交给哪个角色 —— 以前只认 metadata / defaultCharacterId / 第一个角色，
 * 于是「换个人聊」这件事没法做。
 *
 * 存储用现成的 settings 键值（每个聊天一个键），不新建表：
 * 键里带 channel/accountId/conversationRef，**不含任何平台字样**（Core 依旧不认识具体渠道）。
 */

/** 一个聊天的「当前角色」存在哪：渠道 + 账号 + 会话引用三者共同定位 */
export function activeCharacterKey(input: { channel: string; accountId: string; conversationRef: string }): string {
  return ["chatActiveCharacter", input.channel, input.accountId, input.conversationRef].join(".");
}

/** 解析用户发的切换口令；不是口令就返回 none（照常当聊天处理） */
/**
 * explicit = 用户明说了「角色/人物」或「跟…聊」。
 * 只有 explicit 的口令才允许"名字对不上也回一句列表情报"；
 * 「换成什么样都行吗」这种只是句子里带了个"换"字的普通聊天，名字对不上就必须放行去聊天。
 */
export type SwitchCommand =
  | { kind: "list" }
  | { kind: "switch"; name: string; explicit: boolean }
  | { kind: "none" };

const LIST_PATTERNS = [/^(角色列表|有哪些角色|都有哪些角色|角色有哪些)$/, /^角色$/];

/** 去掉引号、书名号这类装饰，别让「换成「Aria」」解析失败 */
const DECORATION = /[\u0022\u0027\u201c\u201d\u300c\u300d\u300e\u300f\u300a\u300b]/g;

function tidy(value: string): string {
  return value.replace(DECORATION, "").replace(/^(?:一下|那个|这个)/, "").trim();
}

function stripName(raw: string): string {
  return tidy(raw)
    // 「换个人物 X」「换个角色 X」里的量词与「角色」两字都不是名字的一部分
    .replace(/^(?:一个|个)?(?:角色|人物)/, "")
    .replace(/^[\s\uff1a:\uff0c,\u3001]+/, "")
    .replace(/(?:聊|聊天|说话|唠嗑)$/, "")
    // 「换成Kai吧」「切换角色 Aria呀」这类语气词不该被当成名字的一部分
    .replace(/[\s\u3002\uff01\uff1f\uff0c\u3001\u5427\u5440\u554a\u5457\u561b]+$/g, "")
    .trim();
}

/**
 * 「换成 X」但没有出现「角色」二字时，X 得像个名字才当口令：
 * 太长的、带疑问词的（什么样、怎么办、谁、吗…）一律当成普通聊天。
 */
function looksLikeName(name: string): boolean {
  if (name.length === 0 || name.length > 12) return false;
  return !/[\u4ec0\u4e48\u600e\u4e3a\u8c01\u5417\u5462\u54ea\u6837\u529e]/.test(name);
}

export function parseSwitchCommand(text: string): SwitchCommand {
  const cleaned = text.trim().replace(/^[\/\uff0f]\s*/, "").replace(/[\u3002\uff01\uff1f]+$/g, "").trim();
  if (cleaned.length === 0) return { kind: "none" };
  if (LIST_PATTERNS.some((pattern) => pattern.test(cleaned))) return { kind: "list" };

  const explicit = /^(?:切换|换|更换|改成|变成)(?:一下)?(?:到|成|为)?\s*(.*)$/.exec(cleaned);
  if (explicit !== null) {
    const name = stripName(explicit[1] ?? "");
    if (name.length === 0) return { kind: "list" };
    const namedRole = /角色|人物/.test(cleaned);
    if (!namedRole && !looksLikeName(name)) return { kind: "none" };
    return { kind: "switch", name, explicit: namedRole };
  }
  const withSomeone = /^(?:我要)?(?:跟|和|与)\s*(.+?)\s*(?:聊|聊天|说话|唠嗑)$/.exec(cleaned);
  if (withSomeone !== null) {
    const name = stripName(withSomeone[1] ?? "");
    return name.length === 0 ? { kind: "list" } : { kind: "switch", name, explicit: true };
  }
  return { kind: "none" };
}

export interface SwitchOutcome {
  /** 要发给用户的话（新会话时就是角色的开场白） */
  text: string;
  /** 渠道层的会话引用（外发目标） */
  conversationRef: string;
  /** 切换后的角色；列表情形为 null */
  characterId: CharacterId | null;
  /** 有没有真的新建会话（新建 = 这条就是开场白） */
  newConversation: boolean;
}

export interface ChatCharacterSwitchDeps {
  characters: CharacterRepository;
  conversations: ConversationService;
  settings: SettingsRepository;
  clock: Clock;
  logger: Logger;
}

export function createChatCharacterSwitch(deps: ChatCharacterSwitchDeps) {
  function list(userId: UserId): CharacterRecord[] {
    return deps.characters.listByUser(userId);
  }

  function readActive(channel: ChannelKind, accountId: string, conversationRef: string): CharacterId | null {
    const value = deps.settings.get<string | null>(activeCharacterKey({ channel, accountId, conversationRef }), null);
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** 按名字找人：先精确、再前缀、最后包含；有歧义就不猜 */
  function resolveByName(
    userId: UserId,
    name: string,
  ): { character: CharacterRecord } | { candidates: CharacterRecord[] } | null {
    const all = list(userId);
    const exact = all.filter((character) => character.name === name);
    if (exact.length === 1) return { character: exact[0] as CharacterRecord };
    if (exact.length > 1) return { candidates: exact };
    const prefix = all.filter((character) => character.name.startsWith(name));
    if (prefix.length === 1) return { character: prefix[0] as CharacterRecord };
    if (prefix.length > 1) return { candidates: prefix };
    const contains = all.filter((character) => character.name.includes(name));
    if (contains.length === 1) return { character: contains[0] as CharacterRecord };
    if (contains.length > 1) return { candidates: contains };
    return null;
  }

  function listText(userId: UserId, currentId: CharacterId | null, note?: string): string {
    const all = list(userId);
    if (all.length === 0) {
      return "你还没有角色。先在网页端的「角色」页建一个（可以用角色工坊写几句设想让 AI 补全），再回来跟我说「切换角色 名字」。";
    }
    const lines = all.map((character) => "- " + character.name + (character.id === currentId ? "（现在在聊）" : ""));
    const example = all.find((character) => character.id !== currentId)?.name ?? all[0]?.name ?? "Aria";
    return [
      note ?? "这里可以换人聊。",
      "",
      "现在的角色：",
      ...lines,
      "",
      "想换谁就跟我说「切换角色 名字」，例如「切换角色 " + example + "」。",
    ].join(String.fromCharCode(10));
  }

  /**
   * 换到指定角色（口令与后台按钮共用这一条）。
   *
   * - 没聊过的角色 → 新建会话（会话创建时写入开场白），返回的 text 就是那句开场白；
   * - 聊过的角色 → 复用原会话，text 是一句确认；
   * - 已经是他 → 什么都不改。
   */
  function switchTo(input: {
    userId: UserId;
    channel: ChannelKind;
    accountId: string;
    conversationRef: string;
    characterId: CharacterId;
  }): SwitchOutcome {
    const character = deps.characters.getById(input.characterId);
    if (character === null) throw notFound("character", input.characterId);
    const current = readActive(input.channel, input.accountId, input.conversationRef);
    if (current === character.id) {
      return {
        text: "现在就在跟「" + character.name + "」聊。",
        conversationRef: input.conversationRef,
        characterId: character.id,
        newConversation: false,
      };
    }

    deps.settings.put(
      activeCharacterKey({ channel: input.channel, accountId: input.accountId, conversationRef: input.conversationRef }),
      character.id,
      deps.clock.nowIso(),
    );

    const existing =
      deps.conversations
        .list(input.userId, 500)
        .find(
          (conversation) =>
            conversation.channel === input.channel &&
            conversation.conversationId === input.conversationRef &&
            conversation.characterId === character.id,
        ) ?? null;

    if (existing !== null) {
      deps.logger.info("chat character switched back to an existing conversation", {
        step: "chat.character.switch",
        status: "completed",
        channel: input.channel,
        characterId: character.id,
        conversationId: existing.id,
      });
      return {
        text: "已经切回「" + character.name + "」，之前聊的都在。",
        conversationRef: input.conversationRef,
        characterId: character.id,
        newConversation: false,
      };
    }

    const conversation = deps.conversations.ensureConversation({
      userId: input.userId,
      characterId: character.id,
      channel: input.channel,
      accountId: input.accountId,
      conversationRef: input.conversationRef,
    });
    const versionId = conversation.characterVersionId ?? null;
    const version = versionId === null ? null : deps.characters.getVersion(versionId);
    const firstMessage = (version?.definition.firstMessage ?? "").trim();
    deps.logger.info("chat character switched; new conversation created", {
      step: "chat.character.switch",
      status: "completed",
      channel: input.channel,
      characterId: character.id,
      conversationId: conversation.id,
      hasFirstMessage: firstMessage.length > 0,
    });
    return {
      text: firstMessage.length > 0 ? firstMessage : "已经切到「" + character.name + "」，说点什么吧。",
      conversationRef: input.conversationRef,
      characterId: character.id,
      newConversation: true,
    };
  }

  return {
    parse: parseSwitchCommand,
    readActive,
    activeCharacterKey,
    switchTo,

    /** 处理一条可能是切换口令的消息；返回 null 表示「不是口令」，交给正常聊天 */
    async handle(input: {
      userId: UserId;
      channel: ChannelKind;
      accountId: string;
      conversationRef: string;
      text: string;
    }): Promise<SwitchOutcome | null> {
      const command = parseSwitchCommand(input.text);
      if (command.kind === "none") return null;

      const current = readActive(input.channel, input.accountId, input.conversationRef);

      if (command.kind === "list") {
        deps.logger.info("chat character switch: listed characters", {
          step: "chat.character.list",
          status: "completed",
          channel: input.channel,
          count: list(input.userId).length,
        });
        return { text: listText(input.userId, current), conversationRef: input.conversationRef, characterId: null, newConversation: false };
      }

      const resolved = resolveByName(input.userId, command.name);
      if (resolved === null && !command.explicit) {
        // 只是句子里带了个"换"字，又对不上任何角色 —— 当聊天处理，别抢话
        return null;
      }
      if (resolved === null) {
        return {
          text: listText(input.userId, current, "没有叫「" + command.name + "」的角色。"),
          conversationRef: input.conversationRef,
          characterId: null,
          newConversation: false,
        };
      }
      if ("candidates" in resolved) {
        const names = resolved.candidates.map((character) => character.name).join("、");
        return {
          text: listText(input.userId, current, "「" + command.name + "」能对上好几个角色：" + names + "。请说得再准一点。"),
          conversationRef: input.conversationRef,
          characterId: null,
          newConversation: false,
        };
      }

      return switchTo({
        userId: input.userId,
        channel: input.channel,
        accountId: input.accountId,
        conversationRef: input.conversationRef,
        characterId: resolved.character.id,
      });
    },
  };
}

export type ChatCharacterSwitch = ReturnType<typeof createChatCharacterSwitch>;
