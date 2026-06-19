-- Add ESPP discount price fields.
-- espp_discount_price_native: the actual (discounted) price paid per share in native currency.
-- espp_discount_price_gbp:    same price converted to GBP using the same FX rate as unit_price_gbp.
-- income_amount_gbp is populated automatically by the server on save when both fields are present:
--   income_amount_gbp = (unit_price_gbp - espp_discount_price_gbp) * quantity
ALTER TABLE txn ADD COLUMN espp_discount_price_native TEXT;
ALTER TABLE txn ADD COLUMN espp_discount_price_gbp    TEXT;
