-- Add tax year configs for 2020-21 and 2021-22.
-- These are needed to support instruments with transaction history starting from 2018 onwards.
--
-- Rates verified against HMRC guidance (gov.uk/capital-gains-tax/rates):
--   CGT on shares: 10% basic / 20% higher (unchanged 2020–2022)
--   AEA: £12,300 (both years)
--   Dividend allowance: £2,000 (both years)
--   Proceeds threshold: 4 × AEA = £49,200 (both years)
--   Higher-rate threshold (personal allowance + basic rate band):
--     2020-21: £12,500 + £37,500 = £50,000
--     2021-22: £12,570 + £37,700 = £50,270

INSERT OR IGNORE INTO tax_year_config VALUES
  ('2020-21', '2020-04-06', '2021-04-05',
   '12300', '0.10', '0.20', NULL, NULL, NULL,
   '2000', '0.0875', '0.3375', '0.3935',
   '49200', '50000'),
  ('2021-22', '2021-04-06', '2022-04-05',
   '12300', '0.10', '0.20', NULL, NULL, NULL,
   '2000', '0.0875', '0.3375', '0.3935',
   '49200', '50270');
