-- Migration: 20261124_add_jaro_winkler_aml_fields
-- Description: Jaro-Winkler sanctions matching (#2560).
--   * sanction_list.aliases   — AKA spellings screened alongside the primary name
--   * aml_screening_audit.matched_alias / match_algorithm — record which
--     spelling matched and how the score was computed, for compliance review.
--
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner handles that.

ALTER TABLE sanction_list
  ADD COLUMN IF NOT EXISTS aliases TEXT[];

ALTER TABLE aml_screening_audit
  ADD COLUMN IF NOT EXISTS matched_alias VARCHAR(255),
  ADD COLUMN IF NOT EXISTS match_algorithm VARCHAR(32);
