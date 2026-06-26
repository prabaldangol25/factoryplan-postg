# Demand Excel Import Format

Upload an `.xlsx` file from the **Demand** tab via the "Import Excel" button.

## Required columns

| Column | Required | Values | Notes |
|---|---|---|---|
| `Product` | ✅ | string | Must match an existing product name in the scenario (case-insensitive). |
| `PeriodType` | ✅ | `quarter` or `month` | |
| `Year` | ✅ | integer ≥ 1 | e.g. `2026` |
| `PeriodIndex` | ✅ | integer | `1..4` for quarter, `1..12` for month |
| `Quantity` | ✅ | integer ≥ 1 | Number of units demanded in that period. |
| `SpreadMode` | optional | `even`, `start`, `end` | Defaults to `even` if missing/blank. |

Column matching is **case-insensitive**. Whitespace inside cells is trimmed.

## Behaviour

- The first sheet in the workbook is used.
- Empty rows are skipped silently.
- Rows referencing an unknown product (no matching `Product` name) are skipped and reported in the import response.
- Rows with invalid `PeriodType` / `SpreadMode` / non-positive numbers are skipped and reported.
- Successful rows are inserted; the import is wrapped in a single transaction so partial failures don't leave the DB inconsistent.

## Example

| Product | PeriodType | Year | PeriodIndex | Quantity | SpreadMode |
|---|---|---|---|---|---|
| Widget | quarter | 2026 | 3 | 20 | even |
| Widget | quarter | 2026 | 4 | 15 | even |
| Gadget | month | 2026 | 7 | 8 | start |
