-- Versioned UI board layouts for the customizable board.
--
-- Each row is a saved layout version; `active = 1` marks the one the board
-- renders. layout_json holds the layout definition as TEXT (SQLite has no JSON
-- type; JSON is stored as TEXT), matching the project convention.
CREATE TABLE ui_layouts (
  id          TEXT PRIMARY KEY,
  version     INTEGER NOT NULL,
  layout_json TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES "user"(id),
  created_at  INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0
);
