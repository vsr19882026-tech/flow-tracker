-- Add a priority column to issues.
ALTER TABLE issues ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium';
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);
