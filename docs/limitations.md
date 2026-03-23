# Known Limitations

All limitations below are verified from actual code — no assumptions.

---

## Reliability

### Cron idempotency is in-memory only

**Code**: `apps/mining/src/server.ts` — `const executionRegistry = new Map<string, boolean>()`

The idempotency registry is a process-level `Map`. If the process restarts after a cron fires but before it marks the key, the flow will re-run.

**Scope**: Only `runDailySummary()` and `runMissedReports()` are guarded. Webhook-triggered flows (`handleMiningReport`, `handleLedgerMessage`) have no idempotency guard.

---

### No webhook deduplication

**Code**: `flows/mining-reporting/src/handler.ts` and `apps/ledger/src/handler.ts` — no dedup check before processing.

If the same WhatsApp message is delivered twice (Meta retries on timeout), it will be processed twice. There is no message ID check against a persistent store.

---

### Cron timezone is server local time

**Code**: `apps/mining/src/server.ts` — `cron.schedule('0 18 * * *', ...)`.

No timezone argument is passed to `node-cron`. Cron fires at 18:00 and 20:00 in whatever timezone the server OS is configured to.

---

## Storage

### Sheets search is in-memory

**Code**: `modules/storage/src/providers/sheets/handler.ts` — loads all rows via Google Sheets API then filters in JavaScript.

The `query` operation on the Sheets adapter fetches the entire sheet range before applying the filter. For large sheets this will be slow and may hit Google Sheets API rate limits.

---

### Sheets first-row header ambiguity

**Code**: `modules/storage/src/providers/sheets/transformer.ts` — treats first non-empty row as a header.

If a sheet has no explicit header row, the first data row is consumed as the header. Its values become column keys and it is lost as data. Flows handle this with a `normalizeRows()` workaround (see `flows/daily-summary/src/flow.ts` and `flows/missed-reports/src/flow.ts`).

---

### Postgres `'query'` operation unsupported

**Code**: `modules/storage/src/adapters/postgres.ts:27-28` — returns `unknown_operation`.

The Postgres adapter handles `'read'`, `'write'`, `'update'`. The `'query'` operation returns `{ ok: false, reason: 'unknown_operation' }`. Use `'read'` with a `query` field for filtered SELECT.

---

## Communication

### Twilio adapter has no env validation

**Code**: `modules/communication/src/twilio.ts:8-10` — uses TypeScript `!` non-null assertion.

```typescript
const sid   = process.env.TWILIO_ACCOUNT_SID!;
const token = process.env.TWILIO_AUTH_TOKEN!;
const from  = process.env.TWILIO_WHATSAPP_NUMBER!;
```

If these env vars are missing at runtime, the adapter will crash with a runtime error rather than returning `{ ok: false }`. The other adapters (Meta, Telegram) validate explicitly and throw descriptive errors.

---

## Intelligence

### OpenAI model is hardcoded

**Code**: `modules/intelligence/src/adapters/openai.ts` — `model: 'gpt-4o-mini'`.

The OpenAI model cannot be overridden via `options.model`. The Anthropic adapter supports `options.model` (defaults to `claude-haiku-4-5-20251001`). The NVIDIA adapter uses the model from `NVIDIA_MODEL` env var.

---

### Intelligence module requires JSON-structured LLM responses

**Code**: `modules/intelligence/src/utils/parser.ts` — all three extraction strategies require the LLM to return a JSON object.

If the LLM returns plain text that cannot be parsed as JSON, the pipeline returns `{ ok: false, reason: 'parse_error' }`. All current task handlers are designed to prompt for JSON output.

---

### Local adapter has no authentication

**Code**: `modules/intelligence/src/adapters/local.ts` — calls Ollama `/api/generate` with no auth headers.

The local adapter assumes Ollama is running unauthenticated on localhost. Not suitable for remote/shared deployments without additional network-level security.

---

## Ingestion

### Webhook signature verification is not active

**Code**: Both `apps/ledger/src/server.ts` and `apps/mining/src/server.ts` call `receive()` without `rawBody`, `headers`, or `secret`.

The `MetaAdapter` only verifies the HMAC-SHA256 signature when all three fields are present in `IngestionInput`. Currently, neither app passes them. Any caller can POST arbitrary payloads to `/webhook` without verification.

---

## Architecture

### No state persistence between flow invocations

`ExecutionContext` is created fresh per `runFlow()` call. There is no persistent state store accessible to flows. Data that needs to survive between invocations must be stored externally (e.g., in Sheets or Postgres) and read as a flow step.

---

### No dead-letter queue for failed webhook messages

Both apps log errors to console and discard them. A failed processing attempt produces only a console log. There is no retry queue, alert, or persistent error record.

---

### `modules/whatsapp` is a standalone Fastify server — not wired to the apps

**Code**: `modules/whatsapp/src/main.ts` — builds a Fastify app that starts independently.

The apps use `ingestion-module`, which imports `modules/whatsapp/src/validator.ts` and `modules/whatsapp/src/normalizer.ts` directly via relative paths. The full whatsapp Fastify server (with Redis/SQLite, rate limiting, idempotency, `/send` endpoint) is not part of the running system.

---

### `modules/sheets` is not used by the running system

**Code**: `modules/storage/src/adapters/sheets.ts:1` — imports from `'../providers/sheets/main'`, not from `'sheets-module'`.

The `modules/sheets` package is a standalone legacy module. The active implementation is the internal copy at `modules/storage/src/providers/sheets/`. The two codebases may diverge independently.

---

### Ledger delete is a soft delete (blank overwrite)

**Code**: `flows/ledger/ledger-delete/flow.ts` — overwrites the last user row with `['','','','','','']`.

Deleted entries are not removed from the sheet; they become blank rows. This means balance and summary calculations see zero-value rows unless explicitly filtered out. There is currently no such filter in any flow.
