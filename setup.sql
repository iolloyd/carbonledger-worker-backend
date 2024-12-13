PRAGMA foreign_keys = OFF;

-- Drop all tables first
DROP TABLE IF EXISTS energy_usage;
DROP TABLE IF EXISTS waitlist;
DROP TABLE IF EXISTS uk_regions;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

-- Create users and sessions tables first
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  picture TEXT
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- Create the regions table
CREATE TABLE uk_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

-- Create the energy usage table
CREATE TABLE energy_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region_id INTEGER NOT NULL,
  timestamp DATETIME NOT NULL,
  demand_actual REAL,
  generation_mw REAL,
  carbon_intensity REAL,
  renewable_percentage REAL,
  FOREIGN KEY (region_id) REFERENCES uk_regions(id)
);

-- Create the waitlist table
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert UK regions
INSERT INTO uk_regions (name) VALUES 
  ('London'),
  ('South East'),
  ('South West'),
  ('East of England'),
  ('West Midlands'),
  ('East Midlands'),
  ('Yorkshire'),
  ('North West'),
  ('North East'),
  ('Wales'),
  ('Scotland'),
  ('Northern Ireland');

-- Insert test data for each region
WITH RECURSIVE
  hours(hour) AS (
    SELECT 0
    UNION ALL
    SELECT hour + 1 FROM hours
    WHERE hour < 23
  )
INSERT INTO energy_usage (region_id, timestamp, demand_actual, generation_mw, carbon_intensity, renewable_percentage)
SELECT 
  r.id,
  datetime('now', '-' || h.hour || ' hours'),
  1000 + ABS(RANDOM() % 500),
  1100 + ABS(RANDOM() % 500),
  200 + ABS(RANDOM() % 100),
  20 + ABS(RANDOM() % 40)
FROM uk_regions r
CROSS JOIN hours h;

PRAGMA foreign_keys = ON;