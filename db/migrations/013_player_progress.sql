-- Future Blue Shark 4.9: persistent progress is derived from completed sessions/results.
-- This migration adds indexes to keep the progress dashboard fast.
CREATE INDEX IF NOT EXISTS idx_player_sessions_user_status ON player_sessions(user_id,status);
CREATE INDEX IF NOT EXISTS idx_exercise_results_user_completed ON exercise_results(user_id,completed,created_at DESC);
