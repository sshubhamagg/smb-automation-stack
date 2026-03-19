# Phase 2 — Contract Design
## Google Sheets Module (v1)

---

## Standard Response Envelope

All operations return a consistent top-level shape.

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "metadata": { ... }
}
```

**Failure:**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": { ... }
  }
}
```

- `data` — present on success, omitted on failure
- `metadata` — present on success where applicable, omitted otherwise
- `error` — present on failure, omitted on success
- `details` — optional, included when additional context aids debugging

---

## Error Codes

| Code | Meaning |
|------|---------|
| `INVALID_INPUT` | Missing or malformed required field |
| `SHEET_NOT_FOUND` | The sheetId does not resolve to a valid sheet |
| `RANGE_NOT_FOUND` | The specified range does not exist |
| `ROW_NOT_FOUND` | The rowIndex is out of bounds |
| `AUTH_FAILED` | Service account authentication failure |
| `API_ERROR` | Google Sheets API returned an unexpected error |
| `INTERNAL_ERROR` | Unclassified internal failure |

---

## Operation 1 — read

Read all rows from a sheet or a specific range.
First row is treated as the header row.
If the header row is missing, empty, or malformed, raw rows are returned without key mapping.

### Input Schema

```json
{
  "sheetId": "string",
  "range": "string"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sheetId` | string | yes | Google Sheets document ID |
| `range` | string | no | Sheet name or A1 notation range (e.g. `Sheet1` or `Sheet1!A1:Z`); if omitted, the entire sheet is read |

### Output Schema — Success

```json
{
  "success": true,
  "data": {
    "rows": [
      { "columnName": "value", "columnName2": "value2" }
    ]
  },
  "metadata": {
    "rowCount": 2,
    "range": "Sheet1!A1:Z3"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.rows` | array | Each element is an object `{ columnName: value }` if header is valid, or an array `["value1", "value2"]` if header is missing/malformed |
| `metadata.rowCount` | number | Number of data rows returned (excludes header) |
| `metadata.range` | string | Actual range read as returned by the API |

- If no data rows exist (only header or empty sheet): `data.rows` is `[]`
- If header row is valid: rows are returned as objects — `{ "columnName": "value" }`
- If header row is missing or malformed: rows are returned as arrays — `["value1", "value2", ...]`

### Output Schema — Failure

```json
{
  "success": false,
  "error": {
    "code": "SHEET_NOT_FOUND",
    "message": "No sheet found for the provided sheetId.",
    "details": {
      "sheetId": "abc123"
    }
  }
}
```

### Examples

**Read full sheet:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1"
}

Output:
{
  "success": true,
  "data": {
    "rows": [
      { "name": "cement", "qty": "50" },
      { "name": "steel", "qty": "20" }
    ]
  },
  "metadata": {
    "rowCount": 2,
    "range": "Sheet1!A1:B3"
  }
}
```

**Empty sheet:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1"
}

Output:
{
  "success": true,
  "data": {
    "rows": []
  },
  "metadata": {
    "rowCount": 0,
    "range": "Sheet1"
  }
}
```

---

## Operation 2 — append

Append a new row to a sheet.
Values are provided as an ordered array of strings, matching the column order of the sheet.

### Input Schema

```json
{
  "sheetId": "string",
  "range": "string",
  "row": ["string", "string", "..."]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sheetId` | string | yes | Google Sheets document ID |
| `range` | string | yes | Sheet name or range where the row will be appended |
| `row` | array of strings | yes | Ordered values to append; one entry per column |

- `row` must be a non-empty array
- All values must be strings
- Order of values must match column order of the sheet

### Output Schema — Success

```json
{
  "success": true,
  "data": {
    "updatedRange": "Sheet1!A4:B4"
  },
  "metadata": {
    "updatedRowCount": 1
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.updatedRange` | string | The range that was written as returned by the API |
| `metadata.updatedRowCount` | number | Always `1` for append |

### Output Schema — Failure

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Field 'row' must be a non-empty array of strings.",
    "details": {
      "field": "row"
    }
  }
}
```

### Examples

**Append a row:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1",
  "row": ["sand", "100"]
}

Output:
{
  "success": true,
  "data": {
    "updatedRange": "Sheet1!A4:B4"
  },
  "metadata": {
    "updatedRowCount": 1
  }
}
```

---

## Operation 3 — update

Update an existing row at a specific index.
`rowIndex` is 1-based and excludes the header row.
The provided row replaces the entire target row.

### Update Behavior

- The provided `row` replaces the entire target row
- If fewer values are provided than columns exist → remaining cells are cleared (`""`)
- If more values are provided than columns exist → extra values are ignored

### Input Schema

```json
{
  "sheetId": "string",
  "range": "string",
  "rowIndex": 1,
  "row": ["string", "string", "..."]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sheetId` | string | yes | Google Sheets document ID |
| `range` | string | yes | Sheet name or range containing the target row |
| `rowIndex` | number | yes | 1-based index of the data row to update (excludes header) |
| `row` | array of strings | yes | Ordered replacement values; one entry per column |

- `rowIndex` must be a positive integer
- `rowIndex: 1` refers to the first data row (row 2 in the sheet, after the header)
- `row` must be a non-empty array of strings

### Output Schema — Success

```json
{
  "success": true,
  "data": {
    "updatedRange": "Sheet1!A2:B2"
  },
  "metadata": {
    "updatedRowCount": 1
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.updatedRange` | string | The range that was written as returned by the API |
| `metadata.updatedRowCount` | number | Always `1` for update |

### Output Schema — Failure

```json
{
  "success": false,
  "error": {
    "code": "ROW_NOT_FOUND",
    "message": "rowIndex 10 is out of bounds. Sheet has 3 data rows.",
    "details": {
      "rowIndex": 10,
      "availableRows": 3
    }
  }
}
```

### Examples

**Update row 2:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1",
  "rowIndex": 2,
  "row": ["steel", "75"]
}

Output:
{
  "success": true,
  "data": {
    "updatedRange": "Sheet1!A3:B3"
  },
  "metadata": {
    "updatedRowCount": 1
  }
}
```

---

## Operation 4 — search

Search rows using a key-value filter object.
Returns all rows where every filter key-value pair matches exactly.

### Search Rules (from Phase 1)
- Exact match only
- Case-sensitive
- AND condition across all filter fields
- String comparison only
- No partial match
- No regex
- No fuzzy logic

### Input Schema

```json
{
  "sheetId": "string",
  "range": "string",
  "filter": {
    "columnName": "value"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sheetId` | string | yes | Google Sheets document ID |
| `range` | string | yes | Sheet name or range to search within |
| `filter` | object | yes | Key-value pairs to match against; all must match (AND) |

- `filter` must be a non-empty object
- All filter values must be strings
- Column names in `filter` must match header row values exactly (case-sensitive)

### Output Schema — Success

```json
{
  "success": true,
  "data": {
    "rows": [
      { "name": "cement", "qty": "50" }
    ]
  },
  "metadata": {
    "matchCount": 1,
    "range": "Sheet1!A1:B3"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.rows` | array | Matching rows as objects `{ columnName: value }` if header is valid, or arrays `["value1", ...]` if header is missing/malformed |
| `metadata.matchCount` | number | Number of rows matched |
| `metadata.range` | string | Range searched as returned by the API |

- If no rows match: `data.rows` is `[]` and `metadata.matchCount` is `0`
- This is NOT an error — it is a valid empty result
- If header row is valid: matched rows returned as objects — `{ "columnName": "value" }`
- If header row is missing or malformed: matched rows returned as arrays — `["value1", "value2", ...]`

### Output Schema — Failure

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Field 'filter' must be a non-empty object.",
    "details": {
      "field": "filter"
    }
  }
}
```

### Examples

**Single filter — match found:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1",
  "filter": { "name": "cement" }
}

Output:
{
  "success": true,
  "data": {
    "rows": [
      { "name": "cement", "qty": "50" }
    ]
  },
  "metadata": {
    "matchCount": 1,
    "range": "Sheet1!A1:B3"
  }
}
```

**Multi-field filter — AND condition:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1",
  "filter": { "name": "cement", "qty": "50" }
}

Output:
{
  "success": true,
  "data": {
    "rows": [
      { "name": "cement", "qty": "50" }
    ]
  },
  "metadata": {
    "matchCount": 1,
    "range": "Sheet1!A1:B3"
  }
}
```

**No match:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1",
  "filter": { "name": "glass" }
}

Output:
{
  "success": true,
  "data": {
    "rows": []
  },
  "metadata": {
    "matchCount": 0,
    "range": "Sheet1!A1:B3"
  }
}
```

**Case-sensitive — no match:**
```json
Input:
{
  "sheetId": "abc123",
  "range": "Sheet1",
  "filter": { "name": "Cement" }
}

Output:
{
  "success": true,
  "data": {
    "rows": []
  },
  "metadata": {
    "matchCount": 0,
    "range": "Sheet1!A1:B3"
  }
}
```

---

## Status

Phase 2 complete. Awaiting approval for Phase 3: Technical Design.
