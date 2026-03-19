# Module 1: WhatsApp Interface Module
## Phase 4: Implementation Plan

**Timestamp:** 2026-03-18
**Version:** v3

---

### Changelog Summary (This File)

| Version | Changes |
|---|---|
| v1 | Initial implementation plan — Python 3.11 + FastAPI, flat folder structure, 10 source files, 6 test files, 5 runtime deps, 47 test cases |
| v2 | Migrated to Node.js 18+ + TypeScript + Fastify. Replaced FastAPI → Fastify, httpx → native fetch, pytest → Jest, requirements.txt → package.json. Added tsconfig.json. All architecture, components, contracts, and test coverage unchanged. |
| v3 | Added raw body preservation requirement (fastify-raw-body), SQLite dev-only clarification (blocks event loop), Promise.race timeout enforcement, idempotency "processing" sentinel + TTL recovery, fetch non-2xx + safe JSON + AbortController handling, correlationId generation on outbound, logging non-blocking constraint. |

---

## 1. Folder Structure

```
whatsapp-module/
├── src/
│   ├── main.ts              # App entry point, route registration
│   ├── config.ts            # Environment variable loading and validation
│   ├── handler.ts           # Request/response logic for all endpoints
│   ├── validator.ts         # Signature verification + payload validation
│   ├── normalizer.ts        # Payload → normalized output transformation
│   ├── idempotency.ts       # Atomic SETNX idempotency logic
│   ├── rateLimiter.ts       # Global + per-user rate limiting
│   ├── outbound.ts          # WhatsApp Cloud API client
│   ├── store.ts             # Redis/SQLite adapter (abstract interface)
│   └── logger.ts            # Structured JSON logger
├── tests/
│   ├── validator.test.ts
│   ├── normalizer.test.ts
│   ├── idempotency.test.ts
│   ├── rateLimiter.test.ts
│   ├── outbound.test.ts
│   └── handler.test.ts
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

**Principles applied:**
- Flat structure — no sub-packages, no deep nesting
- One file per component — mirrors the technical design exactly
- Tests mirror source files 1:1
- No `utils/`, no `helpers/`, no `services/` abstraction layers

---

## 2. File Responsibilities

| File | Responsibility |
|---|---|
| `src/main.ts` | Creates the Fastify app, registers all routes, starts the server |
| `src/config.ts` | Loads and validates all environment variables at startup; exports a single typed config object. Fails fast if required vars are missing. |
| `src/handler.ts` | Orchestrates the full request pipeline for each endpoint; holds no business logic — only sequencing |
| `src/validator.ts` | HMAC signature verification; raw payload structure validation; outbound request field validation |
| `src/normalizer.ts` | Transforms validated raw payload into the normalized message schema |
| `src/idempotency.ts` | Atomic SETNX check + write; duplicate detection; TTL management |
| `src/rateLimiter.ts` | Global inbound counter; per-user inbound counter; outbound global counter |
| `src/outbound.ts` | Constructs and sends HTTP request to WhatsApp Cloud API; parses provider response |
| `src/store.ts` | Abstract store interface (TypeScript interface); Redis implementation; SQLite implementation; selected by config |
| `src/logger.ts` | Structured JSON log builder; PII masking; payload size truncation; stdout emission |
| `tests/validator.test.ts` | Unit tests for signature verification and payload validation logic |
| `tests/normalizer.test.ts` | Unit tests for all normalization transformations |
| `tests/idempotency.test.ts` | Unit tests for duplicate detection, atomic write, TTL behavior |
| `tests/rateLimiter.test.ts` | Unit tests for global and per-user counters, window expiry |
| `tests/outbound.test.ts` | Unit tests for API call construction, success/failure response parsing |
| `tests/handler.test.ts` | Integration tests for full request pipelines across all endpoints |
| `.env.example` | All environment variables with descriptions and example values |
| `package.json` | Dependencies, scripts (start, dev, test, build) |
| `tsconfig.json` | TypeScript compiler configuration |
| `README.md` | Run instructions, env setup, endpoint reference |

---

## 3. Component-to-File Mapping

| Component | File | Notes |
|---|---|---|
| Webhook Handler | `handler.ts` | `handleInbound()`, `handleVerification()` |
| Send Handler | `handler.ts` | `handleSend()` |
| Health Handler | `handler.ts` | `handleHealth()` |
| Validator | `validator.ts` | `verifySignature()`, `validateInbound()`, `validateOutbound()` |
| Normalizer | `normalizer.ts` | `normalize()` |
| Idempotency Layer | `idempotency.ts` | `checkAndLock()`, `writeOutput()` |
| Rate Limiter | `rateLimiter.ts` | `checkGlobalInbound()`, `checkPerUser()`, `checkGlobalOutbound()` |
| Outbound Client | `outbound.ts` | `sendMessage()` |
| Store Adapter | `store.ts` | `get()`, `setnx()`, `set()`, `incr()`, `ping()` |
| Logger | `logger.ts` | `log()`, `maskPii()`, `truncatePayload()` |

---

## 4. Function-Level Responsibilities

### `main.ts`
| Function / Route | Responsibility |
|---|---|
| `buildApp()` | Instantiates Fastify, registers all routes, connects store, loads config. Returns the app instance. |
| `start()` | Calls `buildApp()`, starts listening on configured port |
| Route: `POST /webhook` | Delegates to `handleInbound()` |
| Route: `GET /webhook` | Delegates to `handleVerification()` |
| Route: `POST /send` | Delegates to `handleSend()` |
| Route: `GET /health` | Delegates to `handleHealth()` |

**Raw Body Preservation (CRITICAL):**
Fastify parses the JSON body by default, destroying the raw `Buffer` needed for HMAC signature verification. The app must preserve the raw body before parsing occurs.

- Register `fastify-raw-body` plugin (or use `addContentTypeParser` with a custom parser that saves both raw and parsed forms)
- The raw body must be available as a `Buffer` on the request object at the time `verifySignature()` is called
- Signature verification MUST use the raw `Buffer` — not `JSON.stringify(req.body)`, which is not byte-for-byte identical to the original payload

---

### `config.ts`
| Function | Responsibility |
|---|---|
| `loadConfig()` | Reads `process.env`, validates all required variables are present, returns a frozen typed config object. Throws at startup if any required variable is missing. |

**Exported type:**
```ts
interface Config {
  whatsappVerifyToken: string
  whatsappAppSecret: string
  whatsappApiToken: string
  whatsappPhoneNumberId: string
  storeBackend: 'redis' | 'sqlite'
  redisUrl: string
  sqlitePath: string
  idempotencyTtlSeconds: number
  rateLimitGlobalInbound: number
  rateLimitPerUser: number
  rateLimitOutbound: number
  rateLimitWindowSeconds: number
  webhookTimeoutSeconds: number
  outboundTimeoutSeconds: number
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  logMaxPayloadBytes: number
  port: number
}
```

---

### `handler.ts`
| Function | Responsibility |
|---|---|
| `handleInbound(request, reply)` | Full inbound pipeline: global rate limit → signature check → payload validation → per-user rate limit → idempotency check → normalize → idempotency write → return response. Enforces timeout. Logs `timeout_unsafe` if write not complete before timeout fires. |
| `handleVerification(request, reply)` | Validates `hub.verify_token` query param, returns `hub.challenge` or 403 |
| `handleSend(request, reply)` | Outbound pipeline: validate input → outbound rate limit → call outbound client → return response |
| `handleHealth(request, reply)` | Calls `store.ping()`, returns health status object |
| `buildErrorResponse(code, message, correlationId, details?)` | Constructs standardized error response object matching Phase 2 error schema |

**Timeout Enforcement — `Promise.race` pattern:**

Timeout in `handleInbound` is enforced using `Promise.race()` between the pipeline execution and a timer promise:

```
Promise.race([
  runPipeline(request),           // full inbound pipeline
  timeoutAfter(webhookTimeoutMs)  // rejects after N ms
])
```

- `timeoutAfter` resolves to a sentinel value (not rejects) so the handler can distinguish timeout from pipeline error
- A `idempotencyWriteComplete` flag is set to `true` immediately after `writeOutput()` succeeds
- If the race resolves via timeout:
  - `idempotencyWriteComplete === false` → log `status: "timeout_unsafe"`, return HTTP 200
  - `idempotencyWriteComplete === true` → log `status: "timeout"`, return HTTP 200
- The pipeline promise continues running after timeout resolves — it is not cancelled

**Correlation ID — Outbound:**
If the caller does not provide a `correlationId` in the `POST /send` request body, `handleSend` generates a new UUID before passing to the outbound client. The generated ID is returned in the response. The `correlationId` field in the outbound request schema is required — but this serves as a safety net for callers that omit it.

---

### `validator.ts`
| Function | Responsibility |
|---|---|
| `verifySignature(rawBody: Buffer, header: string, secret: string): boolean` | Computes HMAC-SHA256 of raw body buffer using Node's built-in `crypto` module; compares to header value using `timingSafeEqual`. Returns `true`/`false`. |
| `validateInbound(payload: unknown): ValidatedInbound` | Checks all required structural fields; returns typed validated object or throws `ValidationError` with code and field path |
| `validateOutbound(body: unknown): ValidatedOutbound` | Checks `recipient` (E.164 regex), `text` (non-empty, ≤ 4096 chars), `correlationId` (present). Returns typed result or throws `ValidationError`. |
| `isE164(phone: string): boolean` | Returns `true` if phone string matches E.164 pattern (`/^\+[1-9]\d{7,14}$/`) |

**Note:** HMAC and timing-safe comparison use Node's built-in `node:crypto` — no external dependency.

**Raw body requirement:** `verifySignature` accepts a raw `Buffer` — not a string or parsed object. The raw body must be captured before Fastify's JSON parser runs (see `main.ts` raw body note). Using `JSON.stringify(parsedBody)` instead of the original raw bytes will produce incorrect HMAC results and cause all valid webhooks to fail verification.

---

### `normalizer.ts`
| Function | Responsibility |
|---|---|
| `normalize(payload: ValidatedInbound): NormalizedMessage` | Extracts `messageId`, converts `from` to E.164, converts Unix timestamp to ISO 8601 UTC, maps `type` to `"text"` or `"unsupported"`, extracts `textBody` or `mediaMetadata` as appropriate, generates `correlationId` UUID via `crypto.randomUUID()`, sets `receivedAt`. Returns typed normalized output object. |
| `toE164(rawPhone: string): string` | Prefixes `+` to raw phone string from provider payload |
| `epochToIso(tsString: string): string` | Converts Unix epoch string to UTC ISO 8601 string via `new Date(Number(ts) * 1000).toISOString()` |
| `mapMessageType(providerType: string): 'text' \| 'unsupported'` | Returns `"text"` if `providerType === "text"`, else `"unsupported"` |

**Note:** UUID generation uses Node's built-in `crypto.randomUUID()`. Date conversion uses built-in `Date`. No external dependencies.

---

### `idempotency.ts`
| Function | Responsibility |
|---|---|
| `checkAndLock(messageId: string): Promise<{ isNew: boolean; cachedOutput: NormalizedMessage \| null }>` | Calls `store.setnx(key, "processing", ttl)`. If key was set (new): returns `{ isNew: true, cachedOutput: null }`. If key existed: fetches value; if `"processing"` sentinel or full output, returns `{ isNew: false, cachedOutput }`. |
| `writeOutput(messageId: string, output: NormalizedMessage): Promise<void>` | Overwrites the sentinel key with full normalized output JSON string. Resets TTL. Called only after normalization completes. |
| `buildKey(messageId: string): string` | Returns `idempotency:${messageId}` |

**"processing" sentinel — edge case behavior:**
- When `checkAndLock` finds the key set to `"processing"`, it returns `{ isNew: false, cachedOutput: null }`
- The handler treats `cachedOutput: null` with `isNew: false` as a soft duplicate — it returns HTTP 200 with a minimal `status: "duplicate"` response (normalization never completed for this key, so no full output is available)
- Callers receiving a duplicate response with no normalized body should treat the original event as still in-flight

**TTL-based recovery:**
- The `"processing"` sentinel is written with the full idempotency TTL (default 24h)
- If the process crashes between SETNX and `writeOutput`, the sentinel expires after the TTL
- After expiry, the same `message_id` can be re-processed — the provider retry will be treated as a new message
- This means: within the TTL window, a mid-write crash causes the event to appear as a duplicate; after TTL expiry, it is reprocessable. This is the known, accepted trade-off.

---

### `rateLimiter.ts`
| Function | Responsibility |
|---|---|
| `checkGlobalInbound(): Promise<{ allowed: boolean; retryAfter: number }>` | Atomically increments `ratelimit:inbound:global`; checks against configured limit; returns result |
| `checkPerUser(phoneE164: string): Promise<{ allowed: boolean; retryAfter: number }>` | Atomically increments `ratelimit:inbound:${phoneE164}`; checks against per-user limit; returns result |
| `checkGlobalOutbound(): Promise<{ allowed: boolean; retryAfter: number }>` | Atomically increments `ratelimit:outbound:global`; checks against outbound limit; returns result |
| `buildKey(tier: string, identifier: string): string` | Returns correctly namespaced store key |

---

### `outbound.ts`
| Function | Responsibility |
|---|---|
| `sendMessage(recipient: string, text: string, correlationId: string, config: Config): Promise<OutboundResult>` | Builds provider API request payload; calls `fetch()` with `AbortController` timeout; parses response; returns `OutboundResult`. No retries under any condition. |
| `parseProviderResponse(response: Response): Promise<OutboundResult>` | Extracts `provider_message_id` on 200; extracts error code and message on non-200. Returns structured result. |
| `buildRequestPayload(recipient: string, text: string, phoneNumberId: string): object` | Constructs the exact JSON body required by WhatsApp Cloud API |

**fetch implementation requirements:**
- **Timeout:** Use `AbortController` with `setTimeout` to abort the fetch after `outboundTimeoutSeconds`. Pass the `signal` to the `fetch` call. On abort, catch the `AbortError` and return `status: "failed"` with `code: "PROVIDER_ERROR"`.
- **Non-2xx responses:** Do not throw on non-2xx status. Check `response.ok` or `response.status` explicitly. Extract the error body from non-2xx responses for the `details` field.
- **Safe JSON parsing:** Wrap `response.json()` in a try/catch. If the provider returns a non-JSON body (e.g., HTML error page), catch the parse error and return a generic `PROVIDER_ERROR` rather than letting the parse exception propagate.
- **No retry:** Once `fetch` resolves or rejects (for any reason), return the result immediately. Do not loop or retry.

---

### `store.ts`
| Interface Method | Responsibility |
|---|---|
| `get(key: string): Promise<string \| null>` | Returns value for key or `null` if not found |
| `setnx(key: string, value: string, ttl: number): Promise<boolean>` | Sets key only if it does not exist. Returns `true` if set, `false` if already existed. |
| `set(key: string, value: string, ttl: number): Promise<void>` | Unconditional write with TTL (seconds) |
| `incr(key: string, ttlIfNew: number): Promise<number>` | Atomically increments integer counter; sets TTL on first increment. Returns new count. |
| `ping(): Promise<boolean>` | Lightweight connectivity check. Returns `true`/`false`. |

**TypeScript interface:**
```ts
interface Store {
  get(key: string): Promise<string | null>
  setnx(key: string, value: string, ttl: number): Promise<boolean>
  set(key: string, value: string, ttl: number): Promise<void>
  incr(key: string, ttlIfNew: number): Promise<number>
  ping(): Promise<boolean>
}
```

**Two implementations:**
- `RedisStore` — wraps `redis` (v4); maps each method to Redis commands (`SET NX EX`, `INCR`, etc.)
- `SqliteStore` — wraps `better-sqlite3`; uses synchronous transactions to emulate atomicity; wraps calls in `Promise.resolve()` to satisfy the async interface

Selected at startup by `config.storeBackend`. Both implement the `Store` interface.

**SQLite — dev/local only:**
- `better-sqlite3` is a **synchronous** library. Every `get`, `set`, `incr`, and `setnx` call blocks the Node.js event loop for the duration of the disk I/O.
- This is acceptable for local development and single-process testing where throughput is low.
- **SQLite must not be used in production.** Under any real request load, synchronous disk I/O will degrade response times and starve the event loop.
- Production deployments must use `RedisStore`. The `STORE_BACKEND=sqlite` config value should be treated as a dev-only flag.

---

### `logger.ts`
| Function | Responsibility |
|---|---|
| `log(entry: LogEntry): void` | Assembles log object, applies PII masking, applies size truncation, emits to stdout as single-line JSON via `process.stdout.write()`. Must be non-blocking. |
| `maskPii(phone: string): string` | Returns masked phone string (e.g., `+91*****3210`) |
| `truncatePayload(payload: unknown, maxBytes: number): { data: unknown; truncated: boolean }` | Serializes payload, truncates to max byte size, returns data + truncation flag |
| `truncateText(text: string, maxChars: number): string` | Truncates text to max chars with `…` suffix |

**LogEntry type:**
```ts
interface LogEntry {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  status: string
  messageId?: string
  correlationId: string
  userId?: string
  direction: 'inbound' | 'outbound'
  normalizedOutput?: unknown
  rawPayload?: unknown
  error?: unknown
  durationMs?: number
}
```

**Logging constraints — non-blocking:**
- `log()` must complete synchronously and without awaiting I/O. `process.stdout.write()` is used directly — it is non-blocking for typical log line sizes.
- Avoid heavy serialization inside the hot path. All truncation and PII masking must complete before `process.stdout.write()` is called — but these operations must themselves be cheap (string slicing, byte-length checks only).
- Do not call `JSON.stringify` on deeply nested objects without first applying `truncatePayload`. Serializing a large raw payload without truncation can cause measurable latency in the request handler.
- Never use `console.log` — it is synchronous and flushes on every call, which can block under load.

---

## 5. Configuration Structure

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | yes | — | Webhook verification token |
| `WHATSAPP_APP_SECRET` | yes | — | HMAC secret for signature verification |
| `WHATSAPP_API_TOKEN` | yes | — | Bearer token for WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | — | Provider phone number ID for outbound |
| `STORE_BACKEND` | no | `redis` | `redis` or `sqlite` |
| `REDIS_URL` | if redis | `redis://localhost:6379` | Redis connection URL |
| `SQLITE_PATH` | if sqlite | `./store.db` | SQLite file path |
| `IDEMPOTENCY_TTL_SECONDS` | no | `86400` | Idempotency key TTL (24h) |
| `RATE_LIMIT_GLOBAL_INBOUND` | no | `1000` | Max global inbound requests per window |
| `RATE_LIMIT_PER_USER` | no | `10` | Max inbound requests per sender per window |
| `RATE_LIMIT_OUTBOUND` | no | `100` | Max outbound sends per window |
| `RATE_LIMIT_WINDOW_SECONDS` | no | `60` | Rate limit window size |
| `WEBHOOK_TIMEOUT_SECONDS` | no | `5` | Max inbound webhook processing time |
| `OUTBOUND_TIMEOUT_SECONDS` | no | `10` | Max provider API call time |
| `LOG_LEVEL` | no | `INFO` | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_MAX_PAYLOAD_BYTES` | no | `2048` | Max raw payload size in logs |
| `PORT` | no | `8000` | HTTP listen port |

### `.env.example`

```
# Required
WHATSAPP_VERIFY_TOKEN=your_verify_token_here
WHATSAPP_APP_SECRET=your_app_secret_here
WHATSAPP_API_TOKEN=your_api_token_here
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id_here

# Store
STORE_BACKEND=redis
REDIS_URL=redis://localhost:6379

# Limits (optional — defaults shown)
IDEMPOTENCY_TTL_SECONDS=86400
RATE_LIMIT_GLOBAL_INBOUND=1000
RATE_LIMIT_PER_USER=10
RATE_LIMIT_OUTBOUND=100
RATE_LIMIT_WINDOW_SECONDS=60
WEBHOOK_TIMEOUT_SECONDS=5
OUTBOUND_TIMEOUT_SECONDS=10

# Logging (optional)
LOG_LEVEL=INFO
LOG_MAX_PAYLOAD_BYTES=2048

# Server
PORT=8000
```

---

## 6. Dependency List

### `package.json`

```json
{
  "name": "whatsapp-module",
  "version": "1.0.0",
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node dist/main.js",
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "test": "jest"
  },
  "dependencies": {
    "fastify": "^4.28.0",
    "fastify-raw-body": "^4.3.0",
    "redis": "^4.7.0",
    "better-sqlite3": "^9.6.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.12.0",
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.11.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@types/jest": "^29.5.0"
  }
}
```

**No additional runtime dependencies.**

| Package | Purpose |
|---|---|
| `fastify` | HTTP framework — routing, request/response |
| `fastify-raw-body` | Fastify plugin to preserve raw request body as a `Buffer` — required for HMAC signature verification |
| `redis` | Redis client (used when `STORE_BACKEND=redis`) |
| `better-sqlite3` | SQLite client (used when `STORE_BACKEND=sqlite`) — **dev/local only** |
| `dotenv` | Load `.env` file for local development |

**Built-in Node.js modules used (no install needed):**

| Module | Used for |
|---|---|
| `node:crypto` | HMAC-SHA256 signature verification, `timingSafeEqual`, `randomUUID()` |
| `node:fetch` (global) | Outbound HTTP calls to WhatsApp Cloud API (Node 18 native) |

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 7. Local Development Setup

### Prerequisites
- Node.js 18+
- npm
- Redis running locally (or use `STORE_BACKEND=sqlite` to skip)

### Steps

```
1. Clone the repo and enter the directory
      cd whatsapp-module

2. Install dependencies
      npm install

3. Copy and configure environment variables
      cp .env.example .env
      # Edit .env with your values

4. (Optional) Start Redis locally
      redis-server
      # OR skip and set STORE_BACKEND=sqlite in .env

5. Start the service in development mode (with hot reload)
      npm run dev

6. Build for production
      npm run build
      npm start

7. Verify service is running
      GET http://localhost:8000/health
```

### Webhook Testing Locally
- Use a tunneling tool (e.g., ngrok) to expose `localhost:8000` to the internet
- Register the public URL as the webhook in the Meta developer console
- Or use a REST client to POST directly to `/webhook` with a test payload

---

## 8. Test Strategy

Each component is tested in isolation. No component test depends on another component's implementation. The store is mocked in all unit tests using `jest.fn()`. Fastify's built-in `app.inject()` method is used for handler integration tests — no external HTTP test client required.

### `validator.test.ts`

| Test | Input | Expected |
|---|---|---|
| Valid signature | Correct HMAC header + raw body buffer | Returns `true` |
| Invalid signature | Tampered body | Returns `false` |
| Missing signature header | Empty/undefined header | Returns `false` |
| Valid inbound payload | Well-formed WhatsApp payload | Returns validated data |
| Missing `object` field | Payload without `object` | Throws `ValidationError(INVALID_PAYLOAD)` |
| Missing `messages[0].id` | Payload without message id | Throws `ValidationError(MISSING_FIELD)` |
| Absent `messages` array | Status-update-only payload | Returns OK (no messages to process) |
| Valid outbound request | Correct recipient + text + correlationId | Returns validated data |
| Invalid E.164 format | `"0987654321"` (no `+`) | Throws `ValidationError(INVALID_FORMAT)` |
| Text exceeds 4096 chars | 5000-char string | Throws `ValidationError(INVALID_FORMAT)` |
| Missing `correlationId` | Outbound body without it | Throws `ValidationError(MISSING_FIELD)` |

---

### `normalizer.test.ts`

| Test | Input | Expected |
|---|---|---|
| Text message normalization | Valid text payload | All fields correctly mapped |
| Phone E.164 conversion | `"919876543210"` | `"+919876543210"` |
| Timestamp conversion | `"1710000000"` | `"2024-03-10T00:00:00.000Z"` |
| Media message type mapping | `type: "image"` | `messageType: "unsupported"` |
| Media metadata passthrough | Image payload with media fields | `mediaMetadata` contains raw provider fields |
| Text message has no `mediaMetadata` | Text payload | `mediaMetadata` absent from output |
| Media message has no `textBody` | Image payload | `textBody` absent from output |
| `correlationId` is a valid UUID | Any valid payload | UUID v4 format confirmed |
| `receivedAt` is UTC ISO 8601 | Any valid payload | Format confirmed via `Date.parse()` |

---

### `idempotency.test.ts`

| Test | Scenario | Expected |
|---|---|---|
| New message | `store.setnx` returns `true` | `{ isNew: true, cachedOutput: null }` |
| Duplicate — full output cached | `store.setnx` returns `false`, key has full JSON | `{ isNew: false, cachedOutput: <output> }` |
| Duplicate — processing sentinel | `store.setnx` returns `false`, key is `"processing"` | `{ isNew: false, cachedOutput: null }` |
| `writeOutput` persists correctly | Called with messageId + output | `store.set()` called with correct key + TTL |
| Key format | Any messageId | Key is `idempotency:${messageId}` |
| Store unreachable on check | `store.setnx` throws | Logs warning, returns `{ isNew: true }` — degrades gracefully |

---

### `rateLimiter.test.ts`

| Test | Scenario | Expected |
|---|---|---|
| First request — global inbound | Counter = 0 | `{ allowed: true }` |
| At limit — global inbound | Counter = configured max | `{ allowed: false, retryAfter: N }` |
| First request — per-user | Counter = 0 | `{ allowed: true }` |
| At limit — per-user | Counter = per-user max | `{ allowed: false }` |
| Different users are independent | User A at limit | User B not affected |
| Outbound allowed | Counter below max | `{ allowed: true }` |
| Outbound at limit | Counter = outbound max | `{ allowed: false }` |
| Store unreachable | `store.incr` throws | Logs warning, returns `{ allowed: true }` |
| Key format — per-user | phone `+919876543210` | Key is `ratelimit:inbound:+919876543210` |

---

### `outbound.test.ts`

| Test | Scenario | Expected |
|---|---|---|
| Successful send | Provider returns `200` + `messages[0].id` | `status: "accepted"`, `providerMessageId` set |
| Provider rejection | Provider returns `400` with error body | `status: "failed"`, error code extracted |
| Network timeout | `fetch` aborted via `AbortController` | `status: "failed"`, `code: "PROVIDER_ERROR"` |
| Request payload structure | Any valid input | Correct provider JSON format constructed |
| Auth header present | Any send | `Authorization: Bearer <token>` included |
| No retries on failure | Provider returns `500` | Single attempt only, returns `failed` |

**Note:** `fetch` is mocked with `jest.fn()` for all outbound tests.

---

### `handler.test.ts`

Uses Fastify's built-in `app.inject()` — no external HTTP test client needed.

| Test | Scenario | Expected HTTP + Body |
|---|---|---|
| Inbound text — happy path | Valid signature + valid payload | 200 + normalized output |
| Inbound duplicate | Same messageId twice | 200 + cached output, `status: "duplicate"` |
| Invalid signature | Bad HMAC | 401 + error body with `SIGNATURE_INVALID` |
| Invalid payload structure | Missing `object` field | 400 + error body with `INVALID_PAYLOAD` |
| Global rate limit hit | Counter exceeds global limit | 429 + `Retry-After` header |
| Per-user rate limit hit | Sender exceeds per-user limit | 429 + `Retry-After` header |
| Webhook verification — valid | Correct verify token | 200 + challenge value |
| Webhook verification — invalid | Wrong verify token | 403 |
| Outbound send — accepted | Valid request, provider accepts | 200 + `status: "accepted"` + `providerMessageId` |
| Outbound send — throttled | Outbound rate limit hit | 429 + `status: "throttled"` |
| Outbound send — provider fails | Provider returns error | 502 + `status: "failed"` |
| Health — store ok | Store ping succeeds | 200 + `status: "ok"` |
| Health — store down | Store ping fails | 200 + `status: "degraded"` |
| Media message inbound | Image payload | 200 + `messageType: "unsupported"` + `mediaMetadata` |
| Multi-message payload | `messages[]` has 2 entries | 200 + only first message normalized |
| `correlationId` in all errors | Any error scenario | Error response always contains `correlationId` |
