# Phase 4 — Implementation Plan
## Google Sheets Module (v1)

---

## 1. Folder Structure

```
sheets-module/
├── src/
│   ├── main.ts           # Entry point — exports public functions
│   ├── config.ts         # Env loading and validation
│   ├── handler.ts        # Operation orchestration
│   ├── validator.ts      # Input validation
│   ├── sheetsClient.ts   # Google Sheets API interaction
│   ├── transformer.ts    # Raw API → contract output
│   └── logger.ts         # Structured JSON logging
├── tests/
│   ├── validator.test.ts
│   ├── transformer.test.ts
│   ├── sheetsClient.test.ts
│   └── handler.test.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 2. File Responsibilities

| File | Responsibility |
|------|----------------|
| `main.ts` | Exports `read()`, `append()`, `update()`, `search()` as public API. Wires handler with config. No HTTP server. |
| `config.ts` | Loads env vars via dotenv. Validates required fields. Exports frozen `Config` object. Fails fast if required vars are missing. |
| `handler.ts` | Orchestrates each operation: calls validator → sheets client → transformer → logger. Performs search filtering on transformed rows. Catches all errors and returns standardized error response. |
| `validator.ts` | Validates input shape for each operation. Checks required fields, correct types, non-empty constraints. Returns `INVALID_INPUT` error immediately on failure. No side effects. |
| `sheetsClient.ts` | Initializes Google API JWT auth once. Exposes `getValues()`, `appendValues()`, `updateValues()`. Returns `{ success: true, data }` or `{ success: false, error }`. Does NOT throw for API errors. Only throws for unexpected internal failures. No retries. |
| `transformer.ts` | Converts raw `values[][]` from API into contract output. Owns header detection logic. Owns row mapping. Owns output shaping. No side effects. |
| `logger.ts` | Emits structured JSON to stdout. Accepts `operation`, `status`, optional `error`. Respects `LOG_LEVEL`. No async, no buffering. |

---

## 3. Function-Level Responsibilities

### main.ts
- `read(input)` → delegates to `handler.handle("read", input)`
- `append(input)` → delegates to `handler.handle("append", input)`
- `update(input)` → delegates to `handler.handle("update", input)`
- `search(input)` → delegates to `handler.handle("search", input)`

### config.ts
- `loadConfig()` → reads `process.env`, validates, returns frozen `Config`
- `Config` interface: `{ serviceAccountJson: string, logLevel: string }`

### handler.ts
- `handle(operation, input)` → routes to correct flow, catches errors, returns response
- Internal flows call: `validator.validate()` → `sheetsClient.*()` → `transformer.transform*()`
- For search: applies in-memory filter on transformed rows (AND, exact match, case-sensitive)
- All thrown errors caught here and converted to `{ success: false, error: {...} }`

### validator.ts
- `validateRead(input)` → checks `sheetId` (required string), `range` (optional string)
- `validateAppend(input)` → checks `sheetId`, `range`, `row` (non-empty string array)
- `validateUpdate(input)` → checks `sheetId`, `range`, `rowIndex` (positive int), `row` (non-empty string array)
- `validateSearch(input)` → checks `sheetId`, `range`, `filter` (non-empty object, string values)
- All return `{ valid: true }` or `{ valid: false, error: ErrorObject }`

### sheetsClient.ts
- `initClient(config)` → creates JWT auth, initializes sheets API instance, stores reference
- `getValues(sheetId, range)` → calls `values.get`, returns `{ success: true, data: string[][] }` or `{ success: false, error }`
- `appendValues(sheetId, range, row)` → calls `values.append` with `RAW`, returns `{ success: true, data: { updatedRange } }` or `{ success: false, error }`
- `updateValues(sheetId, range, row)` → calls `values.update` with `RAW`, returns `{ success: true, data: { updatedRange } }` or `{ success: false, error }`

### transformer.ts
- `isValidHeader(row)` → returns `true` if row is non-empty and all cells are non-empty strings
- `mapRows(headers, rows)` → maps `string[][]` to `Record<string, string>[]`
- `transformRead(apiResponse)` → applies header logic, returns `{ rows, rowCount, range, headerValid }`
  - `headerValid` is internal — used by handler to validate search eligibility; never included in API response
- `transformWrite(apiResponse)` → returns `{ updatedRange, updatedRowCount }`

### logger.ts
- `log(entry)` → accepts `{ operation, status, sheetId?, error? }`, emits JSON to stdout
- Respects `LOG_LEVEL`: `"error"` suppresses success logs; `"silent"` suppresses all

---

## 4. Dependencies

### Runtime
```json
{
  "googleapis": "latest",
  "dotenv": "latest"
}
```

### Dev
```json
{
  "typescript": "latest",
  "jest": "latest",
  "ts-jest": "latest",
  "@types/node": "latest",
  "@types/jest": "latest"
}
```

No other packages. No HTTP framework. No utility libraries.

---

## 5. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | Full service account JSON as stringified string |
| `LOG_LEVEL` | no | `"info"` (default), `"error"`, `"silent"` |

- `GOOGLE_SERVICE_ACCOUNT_JSON` is parsed at startup by `config.ts`
- If missing or unparseable, module fails immediately with a clear error
- No API key fallback in v1

---

## 6. Google Client Setup

- Library: `googleapis`
- Auth: `google.auth.JWT` initialized with parsed service account credentials
- Scope: `https://www.googleapis.com/auth/spreadsheets`
- Auth instance created once in `sheetsClient.initClient()`
- Reused across all calls — no re-auth per operation

---

## 7. Test Strategy

### validator.test.ts
- Test each validate function independently
- Cover: missing required fields, wrong types, empty arrays, empty objects, valid inputs
- No mocks needed — pure functions

### transformer.test.ts
- Test `isValidHeader`, `mapRows`, `transformRead`, `transformWrite`, `applyFilter`
- Cover: valid header, missing header, malformed header, empty sheet, AND filter, case-sensitivity, no matches
- No mocks needed — pure functions

### sheetsClient.test.ts
- Mock `googleapis` using `jest.mock()`
- Test `getValues`, `appendValues`, `updateValues`
- Cover: successful response, API error (non-200), auth failure
- Never calls real Google API

### handler.test.ts
- Mock `sheetsClient` and `logger` using `jest.mock()`
- Integration test for each operation end-to-end through handler
- Cover: full success flow, validation failure, API error, transformer output shape
- Verifies final response envelope: `{ success, data, metadata }` or `{ success, error }`

---

## 8. package.json Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "dev": "ts-node src/main.ts"
  }
}
```

---

## 9. tsconfig.json Settings

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true
  }
}
```

---

## 10. .env.example

```
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}
LOG_LEVEL=info
```

---

## 11. Constraints (Enforced)

- No HTTP server — module is a function library
- No retry logic
- No caching
- No batching
- No abstractions beyond the 7 defined files
- Mock-only tests — never call real Google API in tests

---

## Status

Phase 4 complete. Awaiting approval for Phase 5: Implementation.
