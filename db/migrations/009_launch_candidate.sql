CREATE TABLE IF NOT EXISTS audit_events(
 id BIGSERIAL PRIMARY KEY,
 actor_user_id BIGINT,
 event_type TEXT NOT NULL,
 entity_type TEXT,
 entity_id TEXT,
 metadata JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_status ON notification_jobs(status);
CREATE INDEX IF NOT EXISTS idx_billing_entitlements_external_id ON billing_entitlements(external_id);
