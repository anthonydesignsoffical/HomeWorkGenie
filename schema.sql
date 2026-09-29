-- Homework Genie production state store.
-- The application keeps its existing domain model in a single JSONB document
-- while PostgreSQL provides durable production storage and atomic updates.
CREATE TABLE IF NOT EXISTS application_state (
  id SMALLINT PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
