-- Cabal Corner storage (Cloudflare D1). One JSON state row per launch corner, plus sign-in sessions.
CREATE TABLE IF NOT EXISTS corners (
  key TEXT PRIMARY KEY,           -- network:coordinator:launch_id
  state TEXT NOT NULL,            -- JSON, see src/lib/corner.mjs
  salt TEXT NOT NULL,             -- per-corner secret for reveal aliases (never returned)
  version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  exp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  neurons REAL NOT NULL DEFAULT 0
);
