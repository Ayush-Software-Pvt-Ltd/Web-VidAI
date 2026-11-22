-- The data model of docs/SPEC.md section 15. Times are milliseconds since 1970, ids are random
-- hex strings, booleans are 0 or 1, JSON columns are TEXT.
--
-- Deviations from the section's column lists, kept small on purpose (SPEC section 15 says the same):
--   users.last_seen_at  - the admin list shows when an account was last used, also after Sign out.
--   sessions.id         - a session id that is not derived from the cookie token (events, "all except this one").
--   jobs: one active job per video is enforced by a partial unique index (SPEC section 8); the
--     columns active_ms, running_since, video_type, cost_usd, start_now and resume hold what the
--     JobView shows or the queue needs beyond the section's list (time spent running, the video's
--     type at the start, the model cost, "skip the start delay once", "continues a paused session").

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(email) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  may_mark_urgent INTEGER NOT NULL DEFAULT 1 CHECK (may_mark_urgent IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  address TEXT NOT NULL,
  user_agent TEXT NOT NULL
);
CREATE INDEX sessions_by_user ON sessions (user_id);
CREATE INDEX sessions_by_last_used ON sessions (last_used_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
);

CREATE TABLE secrets (
  name TEXT PRIMARY KEY,
  nonce BLOB NOT NULL,
  cipher BLOB NOT NULL,
  last4 TEXT NOT NULL
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  dir TEXT NOT NULL UNIQUE,
  video_type TEXT NOT NULL CHECK (video_type IN ('auto', 'long', 'short')),
  profiles TEXT NOT NULL CHECK (json_valid(profiles)),
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX channels_by_user ON channels (user_id, position);

CREATE TABLE videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  folder_name TEXT NOT NULL,
  type_override TEXT CHECK (type_override IS NULL OR type_override IN ('long', 'short')),
  inputs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(inputs)),
  session_id TEXT,
  session_harness TEXT CHECK (session_harness IS NULL OR session_harness IN ('claudeCode', 'opencode2')),
  archived_at INTEGER,
  progress_memory TEXT CHECK (progress_memory IS NULL OR json_valid(progress_memory)),
  created_at INTEGER NOT NULL,
  UNIQUE (channel_id, folder_name)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'reEdit', 'timelineEdit', 'render')),
  queue TEXT NOT NULL CHECK (queue IN ('edits', 'timeline', 'renders')),
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'running', 'pausing', 'paused', 'stopping', 'stopped', 'failed', 'completed')
  ),
  urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  joined_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  setup TEXT CHECK (setup IS NULL OR setup IN ('claudeSubscription', 'opencodeGo', 'anthropicApi', 'openaiApi')),
  harness TEXT CHECK (harness IS NULL OR harness IN ('claudeCode', 'opencode2')),
  model TEXT,
  effort TEXT,
  request TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(request)),
  progress TEXT CHECK (progress IS NULL OR json_valid(progress)),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  running_since INTEGER,
  video_type TEXT NOT NULL CHECK (video_type IN ('long', 'short')),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  start_now INTEGER NOT NULL DEFAULT 0 CHECK (start_now IN (0, 1)),
  resume INTEGER NOT NULL DEFAULT 0 CHECK (resume IN (0, 1))
);
CREATE INDEX jobs_by_queue_and_state ON jobs (queue, state, joined_at);
CREATE INDEX jobs_by_video ON jobs (video_id);
CREATE INDEX jobs_by_user ON jobs (user_id, state);
-- A video has at most one active job (SPEC section 8).
CREATE UNIQUE INDEX jobs_one_active_per_video ON jobs (video_id)
  WHERE state IN ('queued', 'running', 'pausing', 'paused', 'stopping');

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  frame INTEGER NOT NULL CHECK (frame >= 0),
  shape TEXT CHECK (shape IS NULL OR json_valid(shape)),
  element_id TEXT,
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  job_id TEXT REFERENCES jobs (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX notes_by_video_and_state ON notes (video_id, state);
CREATE INDEX notes_by_job ON notes (job_id);

CREATE TABLE revisions (
  video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  n INTEGER NOT NULL CHECK (n >= 1),
  label TEXT NOT NULL,
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs (id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
  PRIMARY KEY (video_id, n)
);

CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  folder TEXT NOT NULL CHECK (folder IN ('video', 'broll')),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
  created_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL
);
CREATE INDEX uploads_by_user ON uploads (user_id);
CREATE INDEX uploads_by_video ON uploads (video_id);
CREATE INDEX uploads_by_touched ON uploads (touched_at);

-- The log outlives the people in it, so the user is only unlinked (the email stays as text).
CREATE TABLE edit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  user_email TEXT NOT NULL,
  video_label TEXT NOT NULL,
  event TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX edit_log_by_user ON edit_log (user_id, id);

CREATE TABLE progress_history (
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'reEdit', 'timelineEdit', 'render')),
  video_type TEXT NOT NULL CHECK (video_type IN ('long', 'short')),
  seconds REAL NOT NULL CHECK (seconds >= 0),
  finished_at INTEGER NOT NULL
);
CREATE INDEX progress_history_by_kind ON progress_history (kind, video_type, finished_at);

CREATE TABLE launches (
  queue TEXT NOT NULL CHECK (queue IN ('edits', 'timeline', 'renders')),
  at INTEGER NOT NULL
);
CREATE INDEX launches_by_queue ON launches (queue, at);
