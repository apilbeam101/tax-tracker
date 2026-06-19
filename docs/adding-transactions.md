# Adding Transactions

Three ways to add transactions: the web UI, the REST API, or CSV import. All three methods write the same underlying records and trigger the same FX conversion and CGT recalculation.

---

## 1. Manual entry (web UI)

Open an instrument, click **Add transaction**, fill in the form, and save. The form adapts to the transaction type — fields irrelevant to the selected type are hidden.

The minimum required fields for every transaction are:

| Field | Notes |
|---|---|
| Type | See transaction types below |
| Date | Any past date in the instrument's trading history |
| Quantity | Number of shares (fractional shares supported) |

Most types also require **Unit price** and **Currency**. GBP prices need no FX conversion; all other currencies are converted automatically using HMRC monthly rates (the default) or daily spot rates, depending on your `FX_RATE_POLICY` setting.

---

## 2. REST API

All endpoints require an active session cookie and a `X-CSRF-Token` header. Obtain both by logging in via `POST /api/auth/login`.

### Create a single transaction

```
POST /api/transactions
Content-Type: application/json
X-CSRF-Token: <token>
```

**Minimum body (GBP-denominated buy):**

```json
{
  "instrumentId": 3,
  "txnType": "BUY",
  "txnDate": "2024-04-06",
  "quantity": "200",
  "unitPriceNative": "4.52",
  "nativeCurrency": "GBP"
}
```

**Full body (USD buy with explicit costs):**

```json
{
  "instrumentId": 3,
  "txnType": "BUY",
  "txnDate": "2024-04-06",
  "quantity": "200",
  "unitPriceNative": "18.25",
  "nativeCurrency": "USD",
  "fxRateType": "hmrc-monthly",
  "costsGbp": "11.95",
  "notes": "Initial position"
}
```

The response includes all server-computed fields — `unitPriceGbp`, `totalGbp`, `netGbp`, `fxRate`, `rateSource`.

### All transaction fields

| Field | Type | Required | Description |
|---|---|---|---|
| `instrumentId` | integer | yes | ID of the instrument |
| `txnType` | string | yes | See types table below |
| `txnDate` | `YYYY-MM-DD` | yes | Trade or settlement date |
| `quantity` | decimal string | yes | Shares (e.g. `"100"`, `"12.5"`) |
| `unitPriceNative` | decimal string | most types | Price per share in native currency |
| `nativeCurrency` | 3-letter code | most types | `"GBP"`, `"USD"`, `"EUR"`, etc. |
| `fxRateType` | string | no | `"hmrc-monthly"` (default), `"daily-spot"`, `"manual"` |
| `fxRate` | decimal string | if manual | Override rate (GBP per 1 unit of native currency) |
| `costsGbp` | decimal string | no | Broker commission and stamp duty in GBP |
| `notes` | string | no | Free text, max 2 048 characters |
| `splitRatio` | `N/D` string | SPLIT / UNSPLIT | e.g. `"2/1"` for a 2-for-1 split |
| `capreturnsPerShareGbp` | decimal string | CAPRETURN | Capital return amount per share |
| `rsuGrossSharesVested` | decimal string | RSU_VEST | Gross shares before withholding |
| `rsuSharesWithheld` | decimal string | RSU_VEST | Shares withheld for tax |
| `rsuWithholdingRate` | decimal string | RSU_VEST | Effective withholding rate |
| `rsuWithholdingMethod` | string | RSU_VEST | `"net-settlement"` (default), `"sell-to-cover"`, `"cash"` |
| `esppDiscountPriceNative` | decimal string | ESPP_PURCHASE | Discounted purchase price |
| `dividendGrossGbp` | decimal string | DIV_PAY | Gross dividend in GBP |
| `dividendWithholdingGbp` | decimal string | DIV_PAY | Withheld foreign tax |
| `dividendNetGbp` | decimal string | DIV_PAY | Net dividend received |

**Number format:** all decimal strings must be non-negative and match `^\d+(\.\d+)?$`. No scientific notation, no thousands separators, no minus signs.

---

## 3. Transaction types

| `txnType` | Description | S104 pool effect |
|---|---|---|
| `BUY` | Open or add to a position | Adds shares at cost |
| `SELL` | Dispose of shares | Removes shares, triggers CGT calc |
| `DIV_PAY` | Cash dividend | No pool change |
| `DRIP` | Dividend reinvestment | Adds shares at market price |
| `RSU_VEST` | RSU vesting event | Adds shares at market value on vest date |
| `ESPP_PURCHASE` | Employee share purchase plan | Adds shares; income = discount × quantity |
| `SPLIT` | Forward stock split | Multiplies held quantity, adjusts cost basis |
| `UNSPLIT` | Reverse stock split | Divides held quantity, adjusts cost basis |
| `CAPRETURN` | Capital return / return of value | Reduces cost basis |
| `RIGHTS_ISSUE` | Rights issue subscription | Adds shares at subscription price |
| `TRANSFER_IN` | Shares transferred in from another broker | Adds shares at transfer value |
| `TRANSFER_OUT` | Shares transferred out to another broker | Removes shares |

---

## 4. CSV import

Use the import wizard in the UI or call the API directly. Import works in two steps: **preview** (parse only, no writes) then **commit** (write to database).

### Step 1 — preview

```
POST /api/import/preview
Content-Type: application/json
X-CSRF-Token: <token>

{
  "csvText": "<raw CSV content>",
  "mappings": [ ... ],
  "hasHeader": true
}
```

Returns a list of parsed rows with any validation errors highlighted. No data is written.

### Step 2 — commit

```
POST /api/import/commit
Content-Type: application/json
X-CSRF-Token: <token>
```

Same body as preview. Valid rows are inserted; error rows are skipped and returned in the response:

```json
{
  "inserted": 42,
  "errors": [
    { "index": 5, "error": "Unknown ticker: XYZ" }
  ],
  "skippedInvalid": 2
}
```

### Column mappings

Each mapping says "take the value from CSV column `source` and put it in field `target`":

```json
{ "source": "ColumnHeader", "target": "txnDate" }
```

`source` is either a header name (string) or a zero-based column index (number).

**Mappable targets:** `ticker`, `txnType`, `txnDate`, `quantity`, `unitPriceNative`, `nativeCurrency`, `costsGbp`, `notes`.

If your CSV covers a single instrument, omit `ticker` and pass `"instrumentId"` in the request body instead. If your CSV covers multiple instruments, map `ticker` and the server resolves each row by case-insensitive ticker match.

### Transforms

Apply a transform to clean up values before they are validated:

**Static** — replace every value in this column with a fixed constant:
```json
{ "source": "Type", "target": "txnType", "transform": { "kind": "static", "value": "BUY" } }
```

**Map** — translate specific values to their canonical equivalents:
```json
{
  "source": "Type", "target": "txnType",
  "transform": { "kind": "map", "values": { "Bought": "BUY", "Sold": "SELL", "Div": "DIV_PAY" } }
}
```

**Date reformat** — convert a non-ISO date to `YYYY-MM-DD`:
```json
{ "source": "Date", "target": "txnDate", "transform": { "kind": "dateReformat", "fromFormat": "DD/MM/YYYY" } }
```
Supported `fromFormat` values: `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD`.

**Negate** — multiply numeric value by −1 (useful if costs are stored as negative numbers in your export):
```json
{ "source": "Fee", "target": "costsGbp", "transform": { "kind": "negate" } }
```

---

## 5. Worked examples

### Example A — simple single-instrument CSV

You have a spreadsheet export from your broker with this layout:

```
Date,Action,Shares,Price,Currency,Fee
06/04/2024,Buy,200,18.25,USD,11.95
15/04/2024,Sell,50,19.10,USD,9.95
01/05/2024,Buy,100,17.80,USD,11.95
```

Request body:

```json
{
  "csvText": "Date,Action,Shares,Price,Currency,Fee\n06/04/2024,Buy,200,18.25,USD,11.95\n15/04/2024,Sell,50,19.10,USD,9.95\n01/05/2024,Buy,100,17.80,USD,11.95",
  "instrumentId": 3,
  "hasHeader": true,
  "mappings": [
    {
      "source": "Date",
      "target": "txnDate",
      "transform": { "kind": "dateReformat", "fromFormat": "DD/MM/YYYY" }
    },
    {
      "source": "Action",
      "target": "txnType",
      "transform": { "kind": "map", "values": { "Buy": "BUY", "Sell": "SELL" } }
    },
    { "source": "Shares",   "target": "quantity" },
    { "source": "Price",    "target": "unitPriceNative" },
    { "source": "Currency", "target": "nativeCurrency" },
    { "source": "Fee",      "target": "costsGbp" }
  ]
}
```

### Example B — multi-instrument CSV

You export all positions from a broker in one file:

```
Ticker,Date,Type,Qty,UnitPrice,Ccy
CSCO,06/04/2024,BUY,100,55.20,USD
AAPL,06/04/2024,BUY,20,170.00,USD
CSCO,30/04/2024,SELL,50,57.40,USD
```

Request body (no `instrumentId` — resolved per row via ticker):

```json
{
  "csvText": "...",
  "hasHeader": true,
  "mappings": [
    { "source": "Ticker", "target": "ticker" },
    {
      "source": "Date",
      "target": "txnDate",
      "transform": { "kind": "dateReformat", "fromFormat": "DD/MM/YYYY" }
    },
    { "source": "Type",      "target": "txnType" },
    { "source": "Qty",       "target": "quantity" },
    { "source": "UnitPrice", "target": "unitPriceNative" },
    { "source": "Ccy",       "target": "nativeCurrency" }
  ]
}
```

If a ticker in the CSV does not match any instrument in the database, that row is skipped and returned in the `errors` array.

### Example C — RSU vest via API

100 shares vest at $42.00 on 1 April 2024. Your employer withholds 40 shares (net-settlement method):

```json
{
  "instrumentId": 7,
  "txnType": "RSU_VEST",
  "txnDate": "2024-04-01",
  "quantity": "60",
  "unitPriceNative": "42.00",
  "nativeCurrency": "USD",
  "rsuGrossSharesVested": "100",
  "rsuSharesWithheld": "40",
  "rsuWithholdingRate": "0.40",
  "rsuWithholdingMethod": "net-settlement",
  "notes": "FY24 Q1 vest"
}
```

`quantity` is the net shares received (100 − 40 = 60). The server records employment income on the gross vest value and adds 60 shares to the S104 pool at market price.

### Example D — stock split via API

A 3-for-1 forward split on 15 June 2024:

```json
{
  "instrumentId": 3,
  "txnType": "SPLIT",
  "txnDate": "2024-06-15",
  "quantity": "1",
  "splitRatio": "3/1"
}
```

`quantity` is set to `"1"` (required field but not used for splits); the ratio drives the adjustment. The server multiplies all held shares by 3 and divides the pool cost basis by 3.

### Example E — automatic dividend import

If you have an Alpha Vantage API key configured, you can populate dividend history automatically instead of entering each payment manually:

```
POST /api/transactions/import-dividends
Content-Type: application/json
X-CSRF-Token: <token>

{
  "instrumentId": 3,
  "commit": false
}
```

Set `"commit": true` to write the rows. The server skips dividends that fall within ±3 days of an existing `DIV_PAY` transaction (deduplication) and skips any ex-date where your held quantity was zero.

---

## 6. Common validation errors

| Error | Fix |
|---|---|
| `txnDate must be YYYY-MM-DD` | Use a date reformat transform, or fix the source data |
| `quantity must be a non-negative decimal` | Remove commas, currency symbols, or minus signs |
| `Unknown ticker: XYZ` | Add the instrument first, or correct the ticker in the CSV |
| `txnType is required` | Map the type column, or add a static transform to set a default |
| `splitRatio must match N/D` | Use integer numerator and denominator, e.g. `"3/1"` not `"3.0/1"` |
