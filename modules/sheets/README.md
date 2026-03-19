# Google Sheets Module

A standalone, minimal module for reading and writing Google Sheets data.

No HTTP server. No business logic. No schema assumptions.
Exposes four functions: `read`, `append`, `update`, `search`.

---

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your service account credentials
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | Full service account JSON as a stringified string |
| `LOG_LEVEL` | no | `info` (default), `error`, `silent` |

Obtain a service account JSON from Google Cloud Console.
Grant the service account access to the target spreadsheet.

---

## Usage

```typescript
import { read, append, update, search } from './src/main';
```

### read

Read all rows or a specific range.

```typescript
const result = await read({ sheetId: 'your-sheet-id', range: 'Sheet1' });

// result:
// {
//   success: true,
//   data: { rows: [{ name: "cement", qty: "50" }] },
//   metadata: { rowCount: 1, range: "Sheet1" }
// }

// range is optional — omit to read the entire sheet:
const result = await read({ sheetId: 'your-sheet-id' });
```

### append

Append a new row. Values must be ordered to match sheet columns.

```typescript
const result = await append({
  sheetId: 'your-sheet-id',
  range: 'Sheet1',
  row: ['sand', '100'],
});

// result:
// {
//   success: true,
//   data: { updatedRange: "Sheet1!A4:B4" },
//   metadata: { updatedRowCount: 1 }
// }
```

### update

Update an existing row by index. `rowIndex` is 1-based and excludes the header row.

```typescript
const result = await update({
  sheetId: 'your-sheet-id',
  range: 'Sheet1',
  rowIndex: 2,       // updates the 2nd data row (row 3 in the sheet)
  row: ['steel', '75'],
});

// result:
// {
//   success: true,
//   data: { updatedRange: "Sheet1!A3:B3" },
//   metadata: { updatedRowCount: 1 }
// }
```

### search

Search rows using a key-value filter. Exact match, case-sensitive, AND condition.

```typescript
const result = await search({
  sheetId: 'your-sheet-id',
  range: 'Sheet1',
  filter: { name: 'cement' },
});

// result:
// {
//   success: true,
//   data: { rows: [{ name: "cement", qty: "50" }] },
//   metadata: { matchCount: 1, range: "Sheet1" }
// }

// Multi-field filter (AND):
await search({ sheetId: 'id', range: 'Sheet1', filter: { name: 'cement', qty: '50' } });

// No match returns empty rows (not an error):
// { success: true, data: { rows: [] }, metadata: { matchCount: 0 } }
```

---

## Error Shape

All errors follow the same structure:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Field 'sheetId' is required and must be a string",
    "details": { "field": "sheetId" }
  }
}
```

Error codes: `INVALID_INPUT`, `SHEET_NOT_FOUND`, `AUTH_FAILED`, `API_ERROR`, `INTERNAL_ERROR`

---

## Design Notes

- Logging is synchronous (stdout). This is intentional and acceptable for low-throughput SMB use cases.
- `headerValid` is an internal transformer flag used for search validation. It is never exposed in API output.

---

## Scripts

```bash
npm test       # run all tests
npm run build  # compile TypeScript
npm run dev    # run main.ts via tsx
```
