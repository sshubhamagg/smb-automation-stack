# Modules

All modules follow the same contract:
- A single public entry function that **never throws**.
- Returns `ModuleResult<T>` or a structurally compatible type.
- Adapter registry dispatches to the correct provider at call time.
- Modules never import each other.

**Canonical shared type** (`modules/shared/src/types.ts`):

```typescript
export type ModuleResult<T = unknown> =
  | { ok: true; output: T }
  | { ok: false; error: string; reason?: string };
```

---

## ingestion-module

**Package**: `ingestion-module` · **Entry**: `modules/ingestion/src/index.ts`

**Purpose**: Normalize raw inbound webhook payloads into a canonical `NormalizedEvent`.

### Public Function

```typescript
async function receive(input: IngestionInput): Promise<IngestionResult>
```

### Input Type

```typescript
// modules/ingestion/src/types.ts
type IngestionInput = {
  source: string;                      // e.g. 'whatsapp'
  provider: string;                    // e.g. 'meta'
  payload: unknown;                    // parsed JSON body (req.body)
  rawBody?: Buffer | string;           // raw bytes — for HMAC sig verification (optional)
  headers?: Record<string, string>;    // e.g. { 'x-hub-signature-256': '...' }
  secret?: string;                     // HMAC secret (optional)
};
```

### Result Type

```typescript
// modules/ingestion/src/types.ts
type IngestionResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: 'signature_invalid' }
  | { ok: false; reason: 'validation_failed'; error: string }
  | { ok: false; reason: 'status_update' }           // Meta delivery receipt — safe to ignore
  | { ok: false; reason: 'unsupported_type'; type: string }  // image, audio, etc.
  | { ok: false; reason: 'adapter_error'; error: string };
```

### NormalizedEvent

```typescript
// modules/ingestion/src/types.ts
type NormalizedEvent = {
  source: string;          // e.g. 'whatsapp'
  provider: string;        // e.g. 'meta'
  userId: string;          // E.164 phone number, e.g. '+917017875169'
  message?: string;        // text body; absent for non-text types
  raw: unknown;            // original payload, unmodified
  timestamp: number;       // epoch milliseconds
  metadata?: {
    messageId?: string;
    correlationId?: string;
    messageType?: string;
    receivedAt?: string;
    status?: string;
    phoneNumberId?: string;
    [key: string]: any;
  };
};
```

### Registered Adapters

Registry key format: `"source:provider"` (e.g., `"whatsapp:meta"`).

| Source | Provider | Adapter | File |
|---|---|---|---|
| `'whatsapp'` | `'meta'` | `MetaAdapter` | `src/adapters/meta.ts` |

### MetaAdapter Pipeline

`modules/ingestion/src/adapters/meta.ts` — imports from `modules/whatsapp/src/validator.ts` and `modules/whatsapp/src/normalizer.ts` via relative paths.

| Step | Action | Failure reason |
|---|---|---|
| 1 | HMAC-SHA256 signature check (opt-in: only runs when `rawBody+headers+secret` all present) | `signature_invalid` |
| 2 | Validate Meta payload structure (`validateInbound()`) | `validation_failed` |
| 3 | Detect status-only event (`validateInbound()` returns `null`) | `status_update` |
| 4 | Filter non-text messages | `unsupported_type` |
| 5 | Normalize (`normalize()`) → map to `NormalizedEvent` | — |

**Note**: Both apps call `receive()` without `rawBody`, `headers`, or `secret` — signature verification is therefore skipped at runtime.

---

## storage-module

**Package**: `storage-module` · **Entry**: `modules/storage/src/index.ts`

**Purpose**: Abstract read/write operations across storage backends.

### Public Function

```typescript
async function execute(input: StorageInput): Promise<StorageResult>
```

### Input Type

```typescript
// modules/storage/src/types.ts
type StorageInput = {
  provider: string;                        // 'sheets' | 'postgres'
  operation: 'read' | 'write' | 'update' | 'query';
  resource: string;                        // sheetId (sheets) | table name (postgres)
  data?: any;                              // row data for write/update
  query?: Record<string, any>;            // WHERE clause for query/update
  options?: Record<string, any>;          // provider-specific (e.g. range, rowIndex)
};
```

### Result Type

```typescript
// modules/storage/src/types.ts
type StorageResult<T = any> =
  | { ok: true; output: T; metadata?: any }
  | { ok: false; reason?: string; error: string };
```

### Registered Adapters

| Provider | Adapter | File |
|---|---|---|
| `'sheets'` | `SheetsAdapter` | `src/adapters/sheets.ts` |
| `'postgres'` | `PostgresAdapter` | `src/adapters/postgres.ts` |

---

### SheetsAdapter (`modules/storage/src/adapters/sheets.ts`)

Delegates to the internal Sheets provider at `modules/storage/src/providers/sheets/`.

| `operation` | Required fields | Output shape |
|---|---|---|
| `'read'` | `resource` (sheetId), `options.range` optional | `{ rows: Record<string,string>[] \| string[][] }` |
| `'write'` | `resource`, `options.range`, `data` (string[]) | `{ updatedRange: string }` |
| `'update'` | `resource`, `options.range`, `options.rowIndex` (1-based, excludes header), `data` (string[]) | `{ updatedRange: string }` |
| `'query'` | `resource`, `options.range`, `query` (non-empty object) | `{ rows: Record<string,string>[] }` |

**Sheets row behavior**: The Sheets transformer treats the first non-empty row as a header, returning subsequent rows as `Record<string, string>[]`. If the sheet has no explicit header, the first data row is consumed as headers and lost. Flows handle this with `normalizeRows()`.

**Search is in-memory**: `query` loads all rows via Google API then applies filter in JavaScript (exact match, case-sensitive, AND across fields).

**Required env var**: `GOOGLE_SERVICE_ACCOUNT_JSON` — full JSON string of Google service account credentials. Validated at module load time; throws if missing.

---

### PostgresAdapter (`modules/storage/src/adapters/postgres.ts`)

Uses a module-level singleton `Pool` created lazily on first call.

| `operation` | SQL pattern | Required fields |
|---|---|---|
| `'write'` | `INSERT INTO "table" (...) VALUES (...) RETURNING *` | `resource` (table), `data` (non-empty plain object) |
| `'read'` | `SELECT * FROM "table" [WHERE ...]` | `resource`; `query` optional |
| `'update'` | `UPDATE "table" SET ... WHERE ... RETURNING *` | `resource`, `data` (set cols), `query` (WHERE cols — required) |
| `'query'` | Not supported | Returns `{ ok: false, reason: 'unknown_operation' }` |

All SQL uses parameterized placeholders (`$1`, `$2`, ...). Column names are double-quoted.

**Output** (all operations): `{ ok: true, output: { rows: Record<string, unknown>[] }, metadata: { rowCount: number } }`

**Env vars**:

| Variable | Default |
|---|---|
| `POSTGRES_HOST` | `'localhost'` |
| `POSTGRES_PORT` | `5432` |
| `POSTGRES_DB` | `''` |
| `POSTGRES_USER` | `''` |
| `POSTGRES_PASSWORD` | `''` |

---

## communication-module

**Package**: `communication-module` · **Entry**: `modules/communication/src/main.ts`

**Purpose**: Send outbound messages via a registered communication provider.

### Public Function

```typescript
async function execute(input: { to: string; message: string; provider?: string }): Promise<ModuleResult<null>>
```

### Provider Selection

```typescript
// main.ts:19
const provider = input.provider ?? (process.env.COMM_PROVIDER ?? 'twilio');
```

Priority: `input.provider` > `COMM_PROVIDER` env var > `'twilio'` (hardcoded default).

### Result Type

```typescript
{ ok: true; output: null }
// or
{ ok: false; error: string; reason?: 'adapter_not_found' }
```

### Adapter Interface

```typescript
// modules/communication/src/types.ts
interface CommunicationAdapter {
  send(to: string, message: string): Promise<void>;  // throws on failure
}
```

### Registered Adapters

| Provider | Adapter | Transport | File |
|---|---|---|---|
| `'meta'` | `MetaAdapter` | `fetch` → Meta Graph API v18.0 | `src/meta.ts` |
| `'twilio'` | `TwilioAdapter` | `fetch` → Twilio Messages API | `src/twilio.ts` |
| `'telegram'` | `TelegramAdapter` | `axios` → Telegram Bot API | `src/telegram.ts` |

---

### MetaAdapter (`modules/communication/src/meta.ts`)

- POST to `https://graph.facebook.com/v18.0/{WHATSAPP_PHONE_NUMBER_ID}/messages`
- Strips `whatsapp:` prefix and `+` from `phone` before sending.
- Body: `{ messaging_product: 'whatsapp', to, type: 'text', text: { body: message } }`
- **Required env**: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
- Throws if env missing, phone empty, message empty, or API returns non-2xx.

### TwilioAdapter (`modules/communication/src/twilio.ts`)

- POST to `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`
- Basic Auth with `TWILIO_ACCOUNT_SID:TWILIO_AUTH_TOKEN`.
- **Required env**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER` (**no runtime validation** — crashes with runtime error if missing).
- Throws if API returns non-2xx.

### TelegramAdapter (`modules/communication/src/telegram.ts`)

- POST to `https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage`
- Body: `{ chat_id: to, text: message }`. `to` is a Telegram chat ID (numeric string).
- **Required env**: `TELEGRAM_BOT_TOKEN` (validated at call time).
- Throws if token missing, `to` empty, message empty, or API returns `ok: false`.

---

## intelligence-module

**Package**: `intelligence-module` · **Entry**: `modules/intelligence/src/index.ts`

**Purpose**: Run structured AI tasks using a registered LLM provider. Returns validated, typed output — never raw LLM text.

### Public Function

```typescript
async function run(input: AIInput): Promise<AIResult>
```

### Input Type

```typescript
// modules/intelligence/src/types.ts
type AIInput = {
  provider: string;               // 'openai' | 'anthropic' | 'local' | 'nvidia'
  task: string;                   // 'classification' | 'extraction' | 'qa' | 'reasoning'
  input: { text?: string; data?: unknown };
  options?: Record<string, any>;  // task-specific (e.g. categories, fields, question)
};
```

### Result Type

```typescript
// modules/intelligence/src/types.ts
type AIResult<T = any> =
  | { ok: true; task: string; output: T }
  | { ok: false; reason: 'unknown_task' | 'unknown_provider' | 'provider_error' | 'parse_error' | 'validation_error'; error: string };
```

### Pipeline (`modules/intelligence/src/pipeline.ts`)

```
run(input)
  → getTask(input.task)          → error: unknown_task
  → getAdapter(input.provider)   → error: unknown_provider
  → taskHandler.buildPrompt(input) → Prompt { system?, user }
  → adapter.execute(prompt)       → raw LLM text string  → error: provider_error
  → parse(rawText)                → parsed JSON object   → error: parse_error
  → taskHandler.validate(parsed)  → typed output         → error: validation_error
  → { ok: true, task, output }
```

### Registered Adapters

| Provider | Adapter | Default model | Transport | File |
|---|---|---|---|---|
| `'openai'` | `OpenAIAdapter` | `gpt-4o-mini` (hardcoded) | `fetch`, 30s timeout | `src/adapters/openai.ts` |
| `'anthropic'` | `AnthropicAdapter` | `claude-haiku-4-5-20251001` | `@anthropic-ai/sdk`, max_tokens 1024 | `src/adapters/anthropic.ts` |
| `'local'` | `LocalAIAdapter` | `deepseek-r1` | `fetch` → Ollama `/api/generate`, 10s timeout | `src/adapters/local.ts` |
| `'nvidia'` | `NvidiaAdapter` | `meta/llama-3.1-8b-instruct` | `fetch` → NVIDIA NIM API, 30s timeout | `src/adapters/nvidia.ts` |

**OpenAI**: `temperature: 0`, model not overridable via options.
**Anthropic**: model overridable via `options.model`.
**Local**: Ollama-compatible API. Concatenates system + user prompt into a single `prompt` field. Configured via `LOCAL_AI_URL` (default `http://localhost:11434`) and `LOCAL_AI_MODEL` (default `deepseek-r1`).
**NVIDIA**: OpenAI-compatible chat completions API. `temperature: 0`. Configured via `NVIDIA_API_KEY`, `NVIDIA_BASE_URL` (default `https://integrate.api.nvidia.com/v1`), `NVIDIA_MODEL`.

### Registered Tasks

| Task | Handler | Required `options` | Output shape |
|---|---|---|---|
| `'classification'` | `ClassificationHandler` | `categories?: string[]` | `{ label: string, confidence: number, reasoning: string }` |
| `'extraction'` | `ExtractionHandler` | `fields?: string[]` | `{ fields: Record<string, string \| null> }` |
| `'qa'` | `QAHandler` | `question: string` | `{ answer: string, confidence?: number }` |
| `'reasoning'` | `ReasoningHandler` | none | `{ conclusion: string, steps: string[], confidence?: number }` |

### LLM JSON Extraction (`modules/intelligence/src/utils/parser.ts`)

The parser tries three strategies in order:
1. Strip `<think>...</think>` blocks (emitted by reasoning models like DeepSeek).
2. Extract from `` ```json ... ``` `` markdown fences.
3. Find first `{` to last `}` substring.
4. Direct `JSON.parse()` on raw text.

Returns `{ success: false }` only if all three fail.

### Amount Normalization (ExtractionHandler)

The extraction validator normalizes amount strings before returning:
- Strips currency symbols (`₹`, `$`, `€`, `£`, `¥`, `Rs.`, `INR`, etc.)
- Removes thousands separators (`,`)
- Converts `1 lakh` / `1 lac` → `100000`
- Converts `1 crore` / `1 cr` → `10000000`
- Converts `1 thousand` → `1000`
- Preserves `k` suffix (e.g. `2.5k`) — handled by the flow's `parseAmount`

### Env Vars

| Variable | Used by | Default |
|---|---|---|
| `OPENAI_API_KEY` | `OpenAIAdapter` | required |
| `ANTHROPIC_API_KEY` | `AnthropicAdapter` | required |
| `LOCAL_AI_URL` | `LocalAIAdapter` | `http://localhost:11434` |
| `LOCAL_AI_MODEL` | `LocalAIAdapter` | `deepseek-r1` |
| `NVIDIA_API_KEY` | `NvidiaAdapter` | required |
| `NVIDIA_BASE_URL` | `NvidiaAdapter` | `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | `NvidiaAdapter` | `meta/llama-3.1-8b-instruct` |
