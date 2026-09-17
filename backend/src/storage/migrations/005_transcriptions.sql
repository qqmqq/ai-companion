-- Phase 4.5-D3：语音转写（ASR）记录
-- 只存文本与元数据：音频字节永远只存在于 MediaStorage（<dataDir>/media/...），绝不进库。
CREATE TABLE IF NOT EXISTS transcriptions (
  message_ref   TEXT NOT NULL,
  part_index    INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed')),
  text          TEXT,
  language      TEXT,
  duration_ms   INTEGER,
  confidence    REAL,
  provider      TEXT,
  model         TEXT,
  error_code    TEXT,
  error_message TEXT,
  media_id      TEXT,
  fingerprint   TEXT NOT NULL,
  cached        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (message_ref, part_index)
);

CREATE INDEX IF NOT EXISTS idx_transcriptions_status ON transcriptions(status);
CREATE INDEX IF NOT EXISTS idx_transcriptions_media ON transcriptions(media_id);
