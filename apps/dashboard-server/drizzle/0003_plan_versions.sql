-- M5: parent_plan_id links a QA-replanned plan back to its predecessor.
-- Nullable for root plans (the common case). Self-referential FK; project
-- cascade still wipes both rows when a project is deleted.
ALTER TABLE plans ADD COLUMN parent_plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL;
