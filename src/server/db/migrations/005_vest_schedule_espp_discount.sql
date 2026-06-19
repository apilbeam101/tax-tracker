-- Add expected ESPP discount price (per share, in native currency) to vest_schedule.
-- Used to estimate employment income for scheduled ESPP purchase events.
ALTER TABLE vest_schedule ADD COLUMN expected_discount_price_native TEXT;
