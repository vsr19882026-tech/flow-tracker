-- Add a priority to issues. Default 'medium' so existing rows and new inserts
-- that omit priority stay valid; the CHECK mirrors the status constraint style.
ALTER TABLE issues ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high'));
