-- Future Blue Shark 1.8: persistent training results and AI adaptation
CREATE TABLE IF NOT EXISTS exercise_results (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES player_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  difficulty INT CHECK (difficulty BETWEEN 1 AND 5),
  rpe INT CHECK (rpe BETWEEN 1 AND 10),
  fatigue INT CHECK (fatigue BETWEEN 1 AND 10),
  duration_seconds INT,
  reps INT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_exercise_results_user_created
 ON exercise_results(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS training_feedback (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES player_sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  overall_rpe INT CHECK (overall_rpe BETWEEN 1 AND 10),
  fatigue INT CHECK (fatigue BETWEEN 1 AND 10),
  enjoyment INT CHECK (enjoyment BETWEEN 1 AND 5),
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_training_feedback_user_created
 ON training_feedback(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS training_adaptations (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES player_sessions(id) ON DELETE SET NULL,
  decision TEXT NOT NULL CHECK (decision IN ('PROGRESS','MAINTAIN','REDUCE','RECOVER')),
  reason TEXT,
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_training_adaptations_user_created
 ON training_adaptations(user_id, created_at DESC);
