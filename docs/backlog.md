# Backlog

Consolidated list of improvements, bugs, and architectural gaps — all traced to code.

---

## Bugs

### B1: Soft delete leaves blank rows that distort balance/summary
**File**: `flows/ledger/ledger-delete/flow.ts`
**Impact**: High — `ledger-balance` and `ledger-summary` read all rows; a blank row from a soft delete has `Amount: ''` which parses as `NaN` and is silently skipped (`parseFloat` + `isNaN` guard). Net values are correct, but the blank row persists in the sheet indefinitely, growing over time.
**Priority**: Medium
**Suggested fix**: Filter out rows where `Type` is neither `'credit'` nor `'debit'` in balance/summary reads. Or implement a physical row delete using the Sheets API batch delete endpoint.

---

### B2: Twilio adapter crashes on missing env vars instead of returning `{ ok: false }`
**File**: `modules/communication/src/twilio.ts:8-10`
**Impact**: Medium — a missing `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, or `TWILIO_WHATSAPP_NUMBER` causes an unhandled runtime crash rather than a graceful error. The module's "never throw" contract is violated.
**Priority**: Medium
**Suggested fix**: Add explicit checks and throw descriptive `Error` instances (same pattern as `TelegramAdapter`).

---

### B3: No webhook signature verification active
**File**: Both `apps/ledger/src/server.ts` and `apps/mining/src/server.ts`
**Impact**: High (security) — any caller can POST arbitrary JSON to `/webhook`. The HMAC-SHA256 verification is implemented in `MetaAdapter` but never activated.
**Priority**: High
**Suggested fix**: Add `express.raw()` middleware to capture the raw request body, then pass `rawBody`, `headers['x-hub-signature-256']`, and `process.env.WHATSAPP_APP_SECRET` to `receive()`.

---

### B4: Duplicate webhook delivery causes duplicate mining reports
**File**: `flows/mining-reporting/src/handler.ts`
**Impact**: Medium — Meta retries webhook delivery if it doesn't receive a 200 within 20s. A duplicate delivery writes the same report twice to Sheets.
**Priority**: Medium
**Suggested fix**: Check `messageId` against a persistent store (Sheets or Postgres) before processing. The `messageId` is already extracted from the event (`metadata?.messageId`).

---

### B5: `missedReportsFlow` and `dailySummaryFlow` use different sheet range from `miningReportFlow`
**File**: `flows/daily-summary/src/flow.ts`, `flows/missed-reports/src/flow.ts`, `flows/mining-reporting/src/flow.ts`
**Impact**: Low — all three use `range: 'Sheet1'` which is correct. However, if the sheet tab is renamed, this must be updated in three places with no shared constant.
**Priority**: Low
**Suggested fix**: Add a `range` field to the manager config in `managers.json` or to the app's env vars.

---

## Architectural Improvements

### A1: `apps/orchestrator/` referenced in stale code comments but does not exist
**Files**: Various flow files contain inline comments referencing `apps/orchestrator/src/server.ts`.
**Impact**: Low (docs/code confusion)
**Priority**: Low
**Suggested fix**: Search for and update all references to the non-existent orchestrator path.

---

### A2: Cron idempotency is in-memory — lost on restart
**File**: `apps/mining/src/server.ts` — `const executionRegistry = new Map<string, boolean>()`
**Impact**: Medium — if the process restarts after a cron fires but before completion, the flow re-runs.
**Priority**: Medium
**Suggested fix**: Write the execution key to a Sheets row or Postgres table before running and check it on startup.

---

### A3: No flow registry — flows are hardcoded imports in each app
**File**: Both app `server.ts` files
**Impact**: Medium (developer experience) — adding a new flow requires modifying the app file.
**Priority**: Low
**Suggested fix**: A `registerFlow(id, flow)` / `getFlow(id)` registry (no engine changes needed). Would also enable dynamic flow lookup.

---

### A4: `modules/whatsapp` and `modules/sheets` are orphaned standalone modules
**Files**: `modules/whatsapp/`, `modules/sheets/`
**Impact**: Medium (maintenance) — two codebases can diverge from the providers used by the running system (`modules/storage/src/providers/sheets/` and `modules/ingestion/src/adapters/meta.ts` which imports from `modules/whatsapp/src/`).
**Priority**: Low
**Suggested fix**: Either remove the standalone modules and have ingestion import directly from its own internal validator/normalizer, or formally adopt `modules/whatsapp` and `modules/sheets` as shared libraries with versioned contracts.

---

### A5: Ledger intent-router runs a full `runFlow()` for structured-mode messages that always succeed
**File**: `apps/ledger/src/handler.ts:102-109`
**Impact**: Low — for structured mode with valid input, the intent-router flow only evaluates conditions (no steps execute). The overhead is negligible but architecturally noisy.
**Priority**: Low
**Suggested fix**: Call `buildInitialContext` + `resolveRouting` directly without `runFlow()` for the structured path. AI path still needs `runFlow()`.

---

## Performance Issues

### P1: Sheets `query` operation loads entire sheet into memory
**File**: `modules/storage/src/providers/sheets/handler.ts`
**Impact**: High for large sheets — each `query` call fetches all rows, then filters in JavaScript. `ledger-entry` runs a duplicate check on every write.
**Priority**: Medium
**Suggested fix**: For deduplication use cases, consider a time-bounded query (last N rows) or move to Postgres for ledger data.

---

### P2: `ledger-balance` and `ledger-summary` read the entire sheet on every request
**File**: `flows/ledger/ledger-balance/flow.ts`, `flows/ledger/ledger-summary/flow.ts`
**Impact**: Medium — grows proportionally with sheet size.
**Priority**: Low
**Suggested fix**: No short-term fix without pagination or a separate aggregation layer. Acceptable for moderate volumes.

---

## Developer Experience

### D1: Flow files directly access `ctx.state` with string keys and unsafe casts
**Files**: All flow files — e.g. `ctx.state?.['config']?.sheetId`
**Impact**: Low — type safety gap; a misspelled key silently returns `undefined` at runtime.
**Priority**: Low
**Suggested fix**: Typed context builders per flow (the `BuildContextResult` pattern in `ledger-entry` is a good model).

---

### D2: No local development runner — testing a flow requires running the full Express server
**Files**: Both app `server.ts` files
**Impact**: Medium (developer experience) — `POST /run/daily-summary` requires the server to be running locally with all env vars set.
**Priority**: Low
**Suggested fix**: A `scripts/run-flow.ts` CLI that imports a flow and calls `runFlow()` directly with a local config file.

---

### D3: No shared tsconfig base — each package has its own `tsconfig.json`
**Impact**: Low — minor inconsistency risk if TypeScript options diverge across packages.
**Priority**: Low
**Suggested fix**: A root `tsconfig.base.json` with shared `strict`, `target`, `module` settings that each package extends.

---

## AI Reliability

### R1: Intelligence module has no retry on LLM provider errors
**File**: `modules/intelligence/src/pipeline.ts`
**Impact**: Medium — a transient provider error (rate limit, timeout) fails the step immediately with no retry.
**Priority**: Medium
**Suggested fix**: Add configurable retry with exponential backoff inside the pipeline, or at the adapter level.

---

### R2: OpenAI model is hardcoded to `gpt-4o-mini` and not overridable
**File**: `modules/intelligence/src/adapters/openai.ts`
**Impact**: Low — cannot use `gpt-4o` or other OpenAI models without changing source code.
**Priority**: Low
**Suggested fix**: Read model from `options.model` with fallback to `process.env.OPENAI_MODEL ?? 'gpt-4o-mini'`.

---

### R3: Ledger AI mode has no fallback when classification confidence is low
**File**: `flows/ledger/intent-router/flow.ts`
**Impact**: Medium — a low-confidence classification still routes to a sub-flow. There is no threshold check.
**Priority**: Medium
**Suggested fix**: In `resolveRouting()`, check `classifyOut.confidence` against a threshold (e.g. 0.6). If below threshold, treat as invalid input.

---

### R4: Local AI adapter has a short 10-second timeout
**File**: `modules/intelligence/src/adapters/local.ts` — `TIMEOUT_MS = 10_000`
**Impact**: Low — local models (especially larger quantizations) can take >10s for complex prompts.
**Priority**: Low
**Suggested fix**: Make timeout configurable via env var `LOCAL_AI_TIMEOUT_MS`.
