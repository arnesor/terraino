-- Results lists: one row per course of a world, and one per result on it.

-- The course as it was when its first result was saved (ResultsCourse as JSON).
CREATE TABLE courses (
  world TEXT NOT NULL,
  key TEXT NOT NULL,
  course TEXT NOT NULL,
  PRIMARY KEY (world, key)
);

CREATE TABLE results (
  id TEXT PRIMARY KEY,
  world TEXT NOT NULL,
  key TEXT NOT NULL,
  -- The Result as JSON, its route rounded to decimetres.
  result TEXT NOT NULL,
  -- SHA-256 (hex) of the key that lets the runner who saved it delete it.
  delete_hash TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  FOREIGN KEY (world, key) REFERENCES courses (world, key)
);

CREATE INDEX results_by_course ON results (world, key, saved_at);
