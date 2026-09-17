-- Phase 1 基础 schema：用户 / 角色 / 会话 / 消息 / 渠道 / 凭据 / 设置 / 审计。
-- 记忆、关系、情绪、事件、任务、调度等表按 Phase 2/3 计划增量迁移，避免投机性建模。

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  avatar_media_id TEXT,
  current_version_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_characters_user_slug ON characters(user_id, slug);

CREATE TABLE character_versions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  spec_version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  imported_from TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_character_versions_character ON character_versions(character_id, created_at);

CREATE TABLE character_states (
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  account_id TEXT,
  conversation_ref TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX idx_conversations_lookup ON conversations(user_id, character_id, last_message_at DESC);
CREATE UNIQUE INDEX idx_conversations_identity ON conversations(channel, conversation_ref, character_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  text_render TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  provider_message_id TEXT,
  token_count INTEGER,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  branch_of_id TEXT
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_provider ON messages(provider_message_id);

CREATE TABLE channels (
  kind TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE channel_accounts (
  id TEXT PRIMARY KEY,
  channel_kind TEXT NOT NULL REFERENCES channels(kind) ON DELETE CASCADE,
  external_account_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  bound_user_id TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_channel_accounts_external ON channel_accounts(channel_kind, external_account_id);

CREATE TABLE channel_cursors (
  account_id TEXT NOT NULL,
  conversation_ref TEXT NOT NULL DEFAULT '',
  cursor TEXT NOT NULL DEFAULT '',
  pending_cursor TEXT,
  committed_at TEXT,
  PRIMARY KEY (account_id, conversation_ref)
);

-- 凭据密文列；明文永不落库、永不出 API。
CREATE TABLE credentials (
  account_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  nonce TEXT NOT NULL,
  tag TEXT NOT NULL,
  key_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
