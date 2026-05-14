-- Held redesign: replace `topics` with the Result Card output fields.
-- Drops `topics`, adds `next_step` (single string) and `open_questions` (json array).
-- Existing rows get an empty open_questions array via the DEFAULT.

ALTER TABLE `meeting_summaries`
  ADD COLUMN `next_step` TEXT NULL AFTER `summary`,
  ADD COLUMN `open_questions` JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER `decisions`,
  DROP COLUMN `topics`;
