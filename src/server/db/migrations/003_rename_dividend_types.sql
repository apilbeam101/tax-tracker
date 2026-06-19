-- Split the old catch-all DIVIDEND type into two distinct types:
--
--   DRIP    (Dividend Reinvestment Plan) — shares purchased with dividend cash.
--           unit_price_native reflects the stock market price (typically in the $10–$500 range).
--           Enters the S104 pool as a normal acquisition.
--
--   DIV_PAY (Dividend Payment) — cash dividend received.
--           unit_price_native reflects the per-share dividend rate (typically < $5).
--           Taxable as income; eligible for FTCR on withholding tax.
--
-- Distinguisher: unit_price_native >= 5 → DRIP (stock price range)
--                unit_price_native <  5 → DIV_PAY (dividend-per-share range)
-- Rows with NULL unit_price_native → DIV_PAY (cash dividend, price not recorded).
-- This heuristic works for most US stocks; review manually for instruments with unusual price ranges.

UPDATE txn
SET txn_type = 'DRIP'
WHERE txn_type = 'DIVIDEND'
  AND unit_price_native IS NOT NULL
  AND CAST(unit_price_native AS REAL) >= 5;

UPDATE txn
SET txn_type = 'DIV_PAY'
WHERE txn_type = 'DIVIDEND';
