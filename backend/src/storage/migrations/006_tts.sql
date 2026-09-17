-- Phase 4.5-D4：语音合成（TTS）
-- 只存"合成结果的引用与元数据"：音频字节永远只在 MediaStorage，绝不进库。
CREATE TABLE IF NOT EXISTS tts_syntheses (
  fingerprint  TEXT PRIMARY KEY,
  status       TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','skipped')),
  media_id     TEXT,
  mime_type    TEXT,
  duration_ms  INTEGER,
  sample_rate  INTEGER,
  provider     TEXT,
  model        TEXT,
  voice        TEXT,
  language     TEXT,
  format       TEXT,
  text_hash    TEXT,
  text_length  INTEGER,
  error_code   TEXT,
  error_message TEXT,
  message_ref  TEXT,
  cached       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tts_status ON tts_syntheses(status);
CREATE INDEX IF NOT EXISTS idx_tts_message ON tts_syntheses(message_ref);

-- 消息级的 TTS 状态（一段语音代表整条回复；转写仍然是部件级的，两者互不干扰）
ALTER TABLE messages ADD COLUMN tts_json TEXT;
