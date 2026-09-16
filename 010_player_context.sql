-- Future Blue Shark 1.7: persistent player context
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('player','parent','coach','admin')),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS player_assessments (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  age INT,
  position TEXT,
  level TEXT,
  goal TEXT,
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_assessments_user_created
  ON player_assessments(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS player_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  plan_id TEXT,
  status TEXT NOT NULL,
  exercises JSONB NOT NULL DEFAULT '[]'::jsonb,
  feedback JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_user_created
  ON player_sessions(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS player_goals (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  competency TEXT,
  target NUMERIC,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  review_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS ai_decisions (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  decision_type TEXT NOT NULL,
  context JSONB NOT NULL,
  result JSONB NOT NULL,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_decisions_user_created
  ON ai_decisions(user_id, created_at DESC);
