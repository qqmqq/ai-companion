-- Phase 3：关系、情绪历史、事件、任务、调度任务、主动消息决策审计。
-- 原则：Relationship（长期状态）与 Memory（发生过什么）、Emotion（短期状态）三者互不替代。

-- 消息来源：主动消息必须在领域模型里与普通对话明确区分
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'conversation';

-- 上下文快照要能区分"普通回复"与"主动消息"，并记录触发原因
ALTER TABLE context_snapshots ADD COLUMN source TEXT NOT NULL DEFAULT 'conversation';
ALTER TABLE context_snapshots ADD COLUMN trigger_reason TEXT;

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  familiarity REAL NOT NULL DEFAULT 0.05,
  trust REAL NOT NULL DEFAULT 0.10,
  affection REAL NOT NULL DEFAULT 0.05,
  intimacy REAL NOT NULL DEFAULT 0.00,
  respect REAL NOT NULL DEFAULT 0.10,
  dependence REAL NOT NULL DEFAULT 0.00,
  stage TEXT NOT NULL DEFAULT 'stranger',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_relationships_pair ON relationships(user_id, character_id);

CREATE TABLE relationship_milestones (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_relationship_milestones ON relationship_milestones(relationship_id, at);
CREATE UNIQUE INDEX idx_relationship_milestone_key ON relationship_milestones(relationship_id, key);

-- 关系变化流水：用于"关系趋势"，也是防止模型一次跳到满值的审计材料
CREATE TABLE relationship_changes (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  before_value REAL NOT NULL,
  after_value REAL NOT NULL,
  delta REAL NOT NULL,
  clamped INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  source_message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_relationship_changes ON relationship_changes(relationship_id, created_at DESC);

-- 情绪历史：before/after + 原因 + 来源，用于回答"为什么现在这么生气"
CREATE TABLE emotion_history (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id TEXT,
  before_json TEXT,
  after_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  trigger_kind TEXT,
  source_message_id TEXT,
  conversation_id TEXT,
  intensity REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_emotion_history ON emotion_history(character_id, created_at DESC);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  importance REAL NOT NULL DEFAULT 0.5,
  occurred_at TEXT,
  scheduled_at TEXT,
  due_at TEXT,
  completed_at TEXT,
  recurrence TEXT,
  source TEXT NOT NULL DEFAULT 'conversation',
  source_message_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_status_due ON events(status, due_at);
CREATE INDEX idx_events_character ON events(character_id, occurred_at DESC);

-- 任务（工作项）：与模型路由的 TaskType 是两件不同的事，表名用 work_tasks 以示区分
CREATE TABLE work_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 5,
  payload_json TEXT NOT NULL DEFAULT '{}',
  execute_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  started_at TEXT,
  finished_at TEXT,
  last_error TEXT,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_tasks_status ON work_tasks(status, execute_at);
CREATE INDEX idx_work_tasks_character ON work_tasks(character_id, created_at DESC);

CREATE TABLE scheduled_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  run_at TEXT,
  cron_expr TEXT,
  interval_ms INTEGER,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',
  misfire_policy TEXT NOT NULL DEFAULT 'skip',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_scheduled_jobs_due ON scheduled_jobs(enabled, next_run_at);

-- 主动消息决策审计：为什么触发 / 为什么没触发，全都要留下
CREATE TABLE proactive_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  conversation_id TEXT,
  job_id TEXT,
  trigger_kind TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  decision TEXT NOT NULL,                 -- sent | blocked | failed | skipped
  blocked_reason TEXT,
  autonomy TEXT,
  provider_id TEXT,
  model TEXT,
  message_id TEXT,
  context_snapshot_id TEXT,
  latency_ms INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_proactive_decisions ON proactive_decisions(character_id, created_at DESC);
CREATE INDEX idx_proactive_decisions_action ON proactive_decisions(decision, created_at DESC);
