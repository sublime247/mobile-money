-- Migration: 20260530_create_payment_links.down
-- Description: Drop payment_links table and update trigger

DROP TRIGGER IF EXISTS payment_links_updated_at ON payment_links;
DROP FUNCTION IF EXISTS update_payment_links_updated_at();
DROP TABLE IF EXISTS payment_links;
