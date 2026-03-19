# Phase 1 — Module Definition
## Google Sheets Module (v1)

---

## Purpose

Provide a minimal, reliable interface to read and write data from Google Sheets.

This module acts as a generic data layer for SMB use cases.
It does not know what the data means.
It does not apply any rules.
It reads and writes rows.

---

## Responsibilities

| # | Responsibility |
|---|----------------|
| 1 | Read a full sheet and return all rows |
| 2 | Read a specific range and return rows within that range |
| 3 | Append a new row to a sheet |
| 4 | Update an existing row at a given row index |
| 5 | Search rows using a simple key-value filter |
| 6 | Return all results as clean JSON |

---

## Boundaries — What This Module Does NOT Do

- Does NOT apply business logic
- Does NOT interpret data meaning
- Does NOT validate business rules
- Does NOT call AI services
- Does NOT send messages
- Does NOT assume column names or schema
- Does NOT cache data
- Does NOT emit events or call webhooks
- Does NOT persist state outside the sheet

---

## Inputs

Every operation receives:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sheetId` | string | yes | Google Sheets document ID |
| `range` | string | yes (read/update) | A1 notation range (e.g. `Sheet1!A1:Z`) |
| `row` | object | yes (append/update) | Key-value map of column header → value |
| `filter` | object | yes (search) | Key-value map to match against rows |
| `rowIndex` | number | yes (update) | 1-based row index to update |

---

## Outputs

All operations return JSON.

| Operation | Success Output |
|-----------|---------------|
| Read | `{ rows: [ {...}, {...} ] }` |
| Append | `{ success: true, updatedRange: "..." }` |
| Update | `{ success: true, updatedRange: "..." }` |
| Search | `{ rows: [ {...}, {...} ] }` |

All errors return:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```

---

## Behavior Rules

- First row is treated as header row by default
- If header row is missing, empty, or malformed, the module returns raw rows without mapping to keys
- The module must not fail due to header issues
- All column names come from the header row dynamically — no hardcoding
- Row data is returned as `{ columnName: value }` objects
- Empty cells are returned as empty strings `""`
- All values are strings — no type coercion
- No caching — every call reads/writes directly to the Google Sheets API
- No side effects beyond the target sheet operation

---

## Search Behavior (v1)

- Exact match only
- Case-sensitive
- AND condition across all fields
- Only string comparison
- No partial match
- No regex
- No fuzzy logic

---

## Example Scenarios

### Scenario 1 — Read Full Sheet
```
Input:  { sheetId: "abc123", range: "Sheet1" }
Output: { rows: [ { name: "cement", qty: "50" }, { name: "steel", qty: "20" } ] }
```

### Scenario 2 — Append Row
```
Input:  { sheetId: "abc123", range: "Sheet1", row: { name: "sand", qty: "100" } }
Output: { success: true, updatedRange: "Sheet1!A4" }
```

### Scenario 3 — Search Rows
```
Input:  { sheetId: "abc123", range: "Sheet1", filter: { name: "cement" } }
Output: { rows: [ { name: "cement", qty: "50" } ] }
```

### Scenario 4 — Update Row
```
Input:  { sheetId: "abc123", range: "Sheet1", rowIndex: 2, row: { qty: "75" } }
Output: { success: true, updatedRange: "Sheet1!B2" }
```

### Scenario 5 — No Matches Found
```
Input:  { sheetId: "abc123", range: "Sheet1", filter: { name: "glass" } }
Output: { rows: [] }
```

---

## Provider

- Google Sheets API v4
- Authentication: Google Service Account (JSON key file)
- Scope: `https://www.googleapis.com/auth/spreadsheets`

---

## Out of Scope (v1)

- Batch operations
- Multiple sheets in one call
- Sorting or aggregation
- Formula evaluation
- Sheet creation or deletion
- Permission management

---

## Status

Phase 1 complete. Awaiting approval for Phase 2: Contract Design.
