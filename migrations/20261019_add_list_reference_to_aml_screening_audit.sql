-- Records which sanctions/PEP list entry (e.g. OFAC-456) an audit row matched.
ALTER TABLE aml_screening_audit
  ADD COLUMN IF NOT EXISTS list_reference VARCHAR(128);
