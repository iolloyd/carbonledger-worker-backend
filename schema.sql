-- First, create the regions table
DROP TABLE IF EXISTS uk_regions;
CREATE TABLE uk_regions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

-- Insert UK regions
INSERT OR IGNORE INTO uk_regions (name) VALUES 
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

-- Then create the energy usage table
DROP TABLE IF EXISTS energy_usage;
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

-- Finally create the waitlist table
DROP TABLE IF EXISTS waitlist;
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
); 