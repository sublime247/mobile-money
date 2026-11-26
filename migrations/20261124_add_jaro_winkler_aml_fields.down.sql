ALTER TABLE aml_screening_audit
  DROP COLUMN IF EXISTS match_algorithm,
  DROP COLUMN IF EXISTS matched_alias;

ALTER TABLE sanction_list
  DROP COLUMN IF EXISTS aliases;
