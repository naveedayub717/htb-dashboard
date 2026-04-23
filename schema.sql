CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ig_posts (
  id TEXT PRIMARY KEY,
  caption TEXT DEFAULT '',
  thumb TEXT DEFAULT '',
  ts TIMESTAMPTZ,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  format JSONB,
  f_status TEXT,
  plat TEXT DEFAULT 'ig'
);

CREATE TABLE IF NOT EXISTS yt_videos (
  id TEXT PRIMARY KEY,
  caption TEXT DEFAULT '',
  thumb TEXT DEFAULT '',
  ts TIMESTAMPTZ,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  duration INTEGER DEFAULT 0,
  vtype TEXT DEFAULT 'short',
  plat TEXT DEFAULT 'yt'
);

CREATE TABLE IF NOT EXISTS formats (
  pid TEXT PRIMARY KEY,
  status TEXT DEFAULT 'testing',
  format JSONB,
  views INTEGER DEFAULT 0,
  links JSONB DEFAULT '[]',
  added TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ig_manual_formats (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'testing',
  why_it_works TEXT DEFAULT '',
  steps JSONB DEFAULT '[]',
  links JSONB DEFAULT '[]',
  added TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS yt_formats (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'testing',
  why_it_works TEXT DEFAULT '',
  steps JSONB DEFAULT '[]',
  links JSONB DEFAULT '[]',
  added TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hooks (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT DEFAULT 'testing',
  note TEXT DEFAULT '',
  link TEXT DEFAULT '',
  added TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

ALTER TABLE ig_posts ADD COLUMN IF NOT EXISTS outlier_mult TEXT DEFAULT NULL;
ALTER TABLE yt_videos ADD COLUMN IF NOT EXISTS outlier_mult TEXT DEFAULT NULL;
ALTER TABLE ig_posts ADD COLUMN IF NOT EXISTS permalink TEXT DEFAULT NULL;
