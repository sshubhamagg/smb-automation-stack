# Phase 3 — Technical Design
## Google Sheets Module (v1)

---

## 1. Internal Architecture

Single-process service. No background jobs, no queues, no event systems.

```
┌─────────────────────────────────────────────────────┐
│                     Handler                         │
│         (entry point — routes operation)            │
└───────────────────┬─────────────────────────────────┘
                    │
          ┌─────────▼─────────┐
          │     Validator      │
          │  (input only)      │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │   Sheets Client    │
          │  (Google API v4)   │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │    Transformer     │
          │ (raw → contract)   │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │      Logger        │
          │ (shared, passive)  │
          └────────────────────┘
```

---

## 2. Component Responsibilities

### Handler
- Receives operation name and input object
- Calls Validator
- Calls Sheets Client
- Calls Transformer
- Returns final output to caller
- Catches all errors and maps to error response

### Validator
- Checks required fields are present
- Checks field types (string, array, object, number)
- Returns validation error immediately if invalid
- Does NOT check data semantics or business rules

### Sheets Client
- Authenticates using Google Service Account
- Calls Google Sheets API v4 methods: `values.get`, `values.append`, `values.update`
- Returns raw API response
- Throws on non-200 API responses — no silent failures
- No retries

### Transformer
- Converts raw Sheets API response into contract-defined output shape
- Owns header detection and fallback logic
- Owns search filtering logic (search operation only)
- Has no side effects
- `transformRead` output includes `headerValid: boolean`
  - This is an INTERNAL field used only by Handler to determine search eligibility
  - It MUST NOT be exposed in the final API response

### Logger
- Shared utility, called by Handler
- Emits structured JSON to stdout
- Called once per operation: on success and on error

---

## 3. Operation Flows

### read

```
1. Handler receives { sheetId, range? }
2. Validator checks:
   - sheetId: required, string
   - range: optional, string
3. Sheets Client calls values.get:
   - spreadsheetId = sheetId
   - range = range ?? sheetId  (full sheet if omitted)
4. Transformer processes response:
   a. Extract values[][] from API response
   b. If empty → return { rows: [] }
   c. First row → candidate header
   d. Header valid if: non-empty array, all cells non-empty strings
   e. If header valid:
      - Map remaining rows as objects: { headerCell: rowCell }
      - Empty cells mapped to ""
   f. If header invalid/missing:
      - Return rows as raw arrays: [["val1", "val2"], ...]
5. Return standardized response:
   {
     "success": true,
     "data": { "rows": [...] },
     "metadata": { "rowCount": n, "range": "..." }
   }
6. Logger emits { operation: "read", status: "success" }
```

---

### append

```
1. Handler receives { sheetId, range, row }
2. Validator checks:
   - sheetId: required, string
   - range: required, string
   - row: required, non-empty array of strings
3. Sheets Client calls values.append:
   - spreadsheetId = sheetId
   - range = range
   - valueInputOption = "RAW"
   - body = { values: [row] }
4. Return standardized response:
   {
     "success": true,
     "data": { "updatedRange": "..." },
     "metadata": { "updatedRowCount": 1 }
   }
5. Logger emits { operation: "append", status: "success" }
```

---

### update

```
1. Handler receives { sheetId, range, rowIndex, row }
2. Validator checks:
   - sheetId: required, string
   - range: required, string
   - rowIndex: required, positive integer
   - row: required, non-empty array of strings
3. Handler calculates target row:
   - sheetRow = rowIndex + 1  (offset by 1 to skip header row)
   - targetRange = derived from range + sheetRow
     e.g. range = "Sheet1", rowIndex = 2 → "Sheet1!A3"
4. Sheets Client calls values.update:
   - spreadsheetId = sheetId
   - range = targetRange
   - valueInputOption = "RAW"
   - body = { values: [row] }
   - Google Sheets API clears cells beyond provided values automatically
5. Return standardized response:
   {
     "success": true,
     "data": { "updatedRange": "..." },
     "metadata": { "updatedRowCount": 1 }
   }
6. Logger emits { operation: "update", status: "success" }
```

---

### search

```
1. Handler receives { sheetId, range, filter }
2. Validator checks:
   - sheetId: required, string
   - range: required, string
   - filter: required, non-empty object, all values strings
3. Sheets Client calls values.get:
   - spreadsheetId = sheetId
   - range = range
4. Transformer processes response:
   a. Extract values[][] from API response
   b. If empty → return { rows: [] }
   c. First row → candidate header
   d. Header valid if: non-empty array, all cells non-empty strings
   e. If header valid:
      - Map rows as objects (same as read)
      - For each row object, check ALL filter key-value pairs:
        - String equality: row[key] === filter[key]
        - Case-sensitive
        - All keys must match (AND)
      - Collect matching rows
   f. If header invalid/missing:
      - Search is NOT supported without a valid header
      - Return error:
        {
          "success": false,
          "error": {
            "code": "INVALID_INPUT",
            "message": "Search requires a valid header row",
            "details": {}
          }
        }
5. Return standardized response:
   {
     "success": true,
     "data": { "rows": [...] },
     "metadata": { "matchCount": n, "range": "..." }
   }
6. Logger emits { operation: "search", status: "success" }
```

---

## 4. Google Sheets API Usage

| Method | Operation | Parameters |
|--------|-----------|------------|
| `values.get` | read, search | `spreadsheetId`, `range` |
| `values.append` | append | `spreadsheetId`, `range`, `valueInputOption: "RAW"`, `body.values` |
| `values.update` | update | `spreadsheetId`, `range`, `valueInputOption: "RAW"`, `body.values` |

- API version: Google Sheets API v4
- All values sent and received as raw strings (`valueInputOption: "RAW"`)
- No formula interpretation

---

## 5. Authentication

- Provider: Google Service Account
- Credential source: JSON key file path from environment variable
- Scope: `https://www.googleapis.com/auth/spreadsheets`
- No OAuth flow
- No user delegation
- Auth is initialized once at service startup and reused across calls

---

## 6. Header Handling Logic

Lives exclusively in Transformer. Not in Handler, Validator, or Sheets Client.

```
HEADER VALID conditions:
  - First row exists
  - First row is a non-empty array
  - Every cell in the first row is a non-empty string

IF header valid:
  - Use first row cells as object keys
  - Map subsequent rows as: { headerCell: rowCell }
  - Missing/empty cells mapped to ""

IF header invalid or missing:
  - Return rows as raw arrays: [["val1", "val2"], ...]
  - search returns { rows: [] } (cannot apply key-based filter)
```

---

## 7. Search Filter Logic

Lives exclusively in Transformer. No external dependencies.

```
INPUT: rows (array of objects), filter (key-value object)

FOR each row in rows:
  match = true
  FOR each key in filter:
    IF row[key] !== filter[key]:   // strict string equality, case-sensitive
      match = false
      BREAK
  IF match:
    add row to results

RETURN results
```

- Pure in-memory iteration
- No indexing
- No sorting
- No optimization
- O(n * k) where n = rows, k = filter keys

---

## 8. Error Handling

| Error Category | HTTP Status | Error Code | Trigger |
|----------------|-------------|------------|---------|
| Validation error | 400 | `INVALID_INPUT` | Missing/wrong-type field |
| Auth error | 401 | `AUTH_FAILED` | Service account auth failure |
| Sheet not found | 404 | `SHEET_NOT_FOUND` | sheetId does not resolve |
| Range not found | 404 | `RANGE_NOT_FOUND` | Range does not exist |
| Row not found | 404 | `ROW_NOT_FOUND` | rowIndex out of bounds |
| API error | 502 | `API_ERROR` | Google API non-200 response |
| Internal error | 500 | `INTERNAL_ERROR` | Unclassified failure |

- All errors caught by Handler
- All errors returned in standard error envelope
- No retries on any error category
- No swallowed errors — all failures surface to caller

---

## 9. Logging

Structured JSON emitted to stdout. Called once per operation by Handler.

**Success:**
```json
{
  "operation": "read",
  "status": "success",
  "sheetId": "abc123",
  "range": "Sheet1"
}
```

**Failure:**
```json
{
  "operation": "search",
  "status": "error",
  "sheetId": "abc123",
  "error": {
    "code": "INVALID_INPUT",
    "message": "Field 'filter' must be a non-empty object."
  }
}
```

- No PII beyond sheetId and range
- No row data logged
- No filter values logged
- Single log line per operation

---

## 10. Constraints (Enforced)

- No retries under any condition
- No caching at any layer
- No batching
- No background jobs
- No event emission
- No abstractions beyond the 5 defined components
- No performance optimization

---

## Status

Phase 3 complete. Awaiting approval for Phase 4: Implementation Plan.
