-- Uploads go into the `upload` folder of a video or of a channel (docs/SPEC.md section 6, "Uploads"):
-- `channel_id` names the channel, `video_id` is NULL for an upload into the channel's own folder,
-- and the old `folder` (video or broll) is gone. Only unfinished uploads are rows, so they are dropped.
DROP TABLE uploads;
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  video_id TEXT REFERENCES videos (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  received INTEGER NOT NULL DEFAULT 0 CHECK (received >= 0),
  created_at INTEGER NOT NULL,
  touched_at INTEGER NOT NULL
);
CREATE INDEX uploads_by_user ON uploads (user_id);
CREATE INDEX uploads_by_channel ON uploads (channel_id);
CREATE INDEX uploads_by_video ON uploads (video_id);
CREATE INDEX uploads_by_touched ON uploads (touched_at);

-- The storage folders setting is gone (docs/SPEC.md section 5).
DELETE FROM settings WHERE key = 'storageRoots';
