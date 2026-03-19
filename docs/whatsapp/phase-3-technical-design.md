# Module 1: WhatsApp Interface Module
## Phase 3: Technical Design

**Timestamp:** 2026-03-18
**Version:** v2 (Final)

---

### Changelog Summary (This File)

| Version | Changes |
|---|---|
| v1 | Initial technical design — single-service architecture, 6 components, request lifecycle diagrams, storage strategy (Redis/SQLite), error classification, structured logging with PII sanitization |
| v2 | Atomic idempotency (SETNX + "processing" sentinel), two-tier rate limiting (global pre-parse + per-user post-parse), timeout safety rules (timeout_unsafe), `GET /health` endpoint, outbound no-retry policy clarified, log payload size limits |

---

## 1. Internal Architecture

The module runs as a **single deployable HTTP service**. All components live in the same process and are organized as internal modules with clear responsibilities.

```
┌─────────────────────────────────────────────────────┐
│               WhatsApp Interface Service             │
│                                                     │
│  ┌──────────────┐        ┌──────────────────────┐   │
│  │   Inbound    │        │      Outbound        │   │
│  │   Handler    │        │      Handler         │   │
│  └──────┬───────┘        └──────────┬───────────┘   │
│         │                           │               │
│  ┌──────▼───────┐        ┌──────────▼───────────┐   │
│  │  Validator   │        │   Outbound Client    │   │
│  └──────┬───────┘        └──────────────────────┘   │
│         │                                           │
│  ┌──────▼───────┐                                   │
│  │  Normalizer  │                                   │
│  └──────┬───────┘                                   │
│         │                                           │
│  ┌──────▼───────┐                                   │
│  │  Idempotency │                                   │
│  │    Layer     │                                   │
│  └──────┬───────┘                                   │
│         │                                           │
│  ┌──────▼───────┐                                   │
│  │ Rate Limiter │  (global + per-user, two-tier)    │
│  └──────────────┘                                   │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │              Logger (shared)                │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │          Persistent Store (Redis/SQLite)    │    │
│  │   - Idempotency keys   - Rate limit counts  │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

---

## 2. Request Lifecycle

### Inbound Webhook — `POST /webhook`

```
1. Request received
       │
2. Rate Limiter — GLOBAL check (before any parsing)
   ├── EXCEEDED  →  HTTP 429, log status: "throttled", STOP
   └── OK  →  continue
       │
3. Signature Verifier (raw body, before JSON parse)
   ├── INVALID   →  HTTP 401, log status: "rejected", STOP
   └── VALID     →  continue
       │
4. Payload Validator (JSON parse + structural check)
   ├── INVALID   →  HTTP 400, log status: "rejected", STOP
   └── VALID     →  continue
       │
5. Rate Limiter — PER-USER check (phone number now known from payload)
   ├── EXCEEDED  →  HTTP 429, log status: "throttled", STOP
   └── OK        →  continue
       │
6. Idempotency Check + Write — ATOMIC (SETNX or equivalent)
   ├── DUPLICATE →  return cached normalized output, HTTP 200,
   │                log status: "duplicate", STOP
   └── NEW       →  lock acquired, continue
       │
7. Normalizer
   - Extract message_id, phone_number (E.164), timestamp (ISO 8601),
     message_type, text_body / media_metadata
       │
8. Idempotency Write — persist normalized output to acquired lock key
   ⚠ Timeout must NOT fire before this step completes.
   If timeout fires AFTER step 6 lock acquisition but BEFORE step 8 write,
   this is an UNSAFE TIMEOUT — log explicitly with status: "timeout_unsafe"
       │
9. Return normalized output
   HTTP 200, log status: "received"
```

> **Timeout Safety Rule:** The 5-second timeout window covers the full pipeline. If the timeout fires between step 6 (lock acquired) and step 8 (write complete), the service logs `status: "timeout_unsafe"` — indicating the idempotency entry was not persisted and the event may be re-processed on provider retry. This is treated as a warning, not an error, and HTTP 200 is still returned to prevent a retry storm.

---

### Webhook Verification — `GET /webhook`

```
1. Request received
       │
2. Validate hub.verify_token against config
   ├── MISMATCH  →  HTTP 403, STOP
   └── MATCH     →  return hub.challenge, HTTP 200
```

---

### Outbound Send — `POST /send`

```
1. Request received
       │
2. Input Validator
   ├── INVALID   →  HTTP 400, log status: "rejected", STOP
   └── VALID     →  continue
       │
3. Rate Limiter (outbound global)
   ├── EXCEEDED  →  HTTP 429, return status: "throttled", log, STOP
   └── OK        →  continue
       │
4. Outbound Client
   - Send to WhatsApp Cloud API
   ├── API ERROR →  HTTP 502, return status: "failed" + error, log
   └── SUCCESS   →  HTTP 200, return status: "accepted" + provider_message_id, log
```

---

### Health Check — `GET /health`

```
1. Request received
       │
2. Check store connectivity (lightweight ping)
       │
3. Return health status object, HTTP 200 (or 503 if service cannot respond)
```

**Response schema:**
```json
{
  "status":    "ok" | "degraded",
  "service":   "ok",
  "store":     "ok" | "unreachable",
  "timestamp": "2024-03-10T06:13:21Z"
}
```

- `status: "ok"` — all components healthy
- `status: "degraded"` — service is running but store is unreachable; idempotency and rate limiting are non-functional
- HTTP `200` in both cases; HTTP `503` only if the service itself cannot respond

---

## 3. Key Components

---

### 3.1 Webhook Handler

**Responsibility:** Entry point for all inbound HTTP requests. Routes to the correct pipeline. Owns timeout enforcement.

**Behaviors:**
- Reads and preserves raw request body (required for HMAC verification before JSON parse)
- Starts a configurable timeout timer (default 5s) on request receipt
- On timeout before idempotency write: logs `status: "timeout_unsafe"`, returns HTTP 200
- On timeout after idempotency write: logs `status: "timeout"`, returns HTTP 200
- Assembles final HTTP response from pipeline output
- Does no business logic — delegates entirely to internal components

---

### 3.2 Validator

**Responsibility:** Structural and semantic validation of all inputs.

**Inbound webhook validation:**
- Verify `X-Hub-Signature-256` HMAC against raw body and configured secret
- Check `object == "whatsapp_business_account"`
- Check `entry[0].changes[0].field == "messages"`
- Check `messaging_product == "whatsapp"`
- Check `messages[0].id` and `messages[0].from` are present
- If `messages` array is absent → treat as status-update, return OK silently
- If `messages` array has > 1 entry → process index 0 only, log others as `status: "ignored"`

**Outbound request validation:**
- Check `recipient` matches E.164 pattern
- Check `text` is non-empty and ≤ 4096 chars
- Check `correlation_id` is present

**On failure:** Returns a structured `ValidationError` object; the handler converts this to the standardized HTTP error response.

---

### 3.3 Normalizer

**Responsibility:** Transform a validated raw payload into the strict normalized output schema.

**Transformations:**
- `message_id` ← `messages[0].id`
- `phone_number` ← `messages[0].from` prefixed with `+` → E.164
- `timestamp` ← `messages[0].timestamp` (Unix epoch) → UTC ISO 8601
- `message_type` ← `messages[0].type` mapped to `"text"` or `"unsupported"`
- `text_body` ← `messages[0].text.body` (only if type is `text`)
- `media_metadata` ← raw media fields passed through (only if type is not `text`)
- `correlation_id` ← new UUID generated here
- `received_at` ← current UTC time in ISO 8601
- `status` ← `"received"` (idempotency layer sets `"duplicate"` on cache hit)

**Rules:**
- Produces output only — no I/O, no side effects
- Does not call the store or logger directly
- Purely deterministic given the same input

---

### 3.4 Idempotency Layer

**Responsibility:** Prevent duplicate processing using atomic operations.

**Atomic Check + Write (SETNX pattern):**
- Use a single atomic `SETNX` (Set if Not Exists) operation combining the check and write into one store operation
- Eliminates the race condition where two concurrent requests with the same `message_id` both pass the check before either writes
- On `SETNX` success (key did not exist): lock is acquired, processing continues, normalized output is written to the same key after normalization
- On `SETNX` failure (key exists): duplicate detected, return cached normalized output

**Key format:** `idempotency:{message_id}`
**TTL:** Configurable (default: 24 hours), set at write time

**Two-phase write:**
1. `SETNX idempotency:{message_id} "processing"` — atomic lock acquisition
2. After normalization: update key value to full normalized output JSON

**Race condition protection:** Between phases 1 and 2, any concurrent request hitting the same `message_id` sees the `"processing"` sentinel and treats it as a duplicate — it returns early without double-processing. This is an acceptable trade-off.

**Store backend:** Abstracted behind a simple `get`, `setnx`, `set` interface. Implemented by Redis (preferred) or SQLite (fallback), swappable via config.

**Failure behavior:** If the store is unreachable, log a warning and continue without idempotency protection. Do not block the request.

---

### 3.5 Rate Limiter

**Responsibility:** Two-tier protection — global and per-user — applied at different pipeline stages.

**Tier 1 — Global (applied before payload parsing):**
- Protects the service from raw request volume regardless of sender
- Key: `ratelimit:inbound:global`
- Configurable: max requests per time window across all senders
- Applied first — before signature verification or JSON parsing

**Tier 2 — Per-User (applied after phone number is extracted from payload):**
- Protects against a single sender flooding the service
- Key: `ratelimit:inbound:{phone_number_e164}`
- Configurable: max requests per sender per time window (e.g., 10 per 60 seconds)
- Applied after validation, once phone number is known

**Outbound (global):**
- Key: `ratelimit:outbound:global`
- Configurable: max sends per time window
- Applied before calling the provider API

**Implementation:** Fixed window counter using atomic increment (`INCR` + `EXPIREAT` on first increment). Simple, predictable, avoids distributed clock issues.

**On exceed:**
- Inbound: HTTP 429 with `Retry-After` header
- Outbound: response `status: "throttled"` with `retry_after_seconds`

**Failure behavior:** If the store is unreachable, skip rate limiting and log a warning. Do not block the request.

---

### 3.6 Outbound Client

**Responsibility:** Deliver messages to the WhatsApp Business Cloud API.

**Behaviors:**
- Accepts `recipient`, `text`, `correlation_id`
- Constructs provider API request payload
- Sends HTTP POST to the WhatsApp Cloud API messages endpoint
- Applies a configurable request timeout to the provider call (default: 10s)
- Parses the provider response:
  - On success: extracts `provider_message_id`, returns `status: "accepted"`
  - On failure: extracts provider error code and message, returns `status: "failed"`

**No automatic retries:**
- The outbound client makes exactly one attempt per call
- On any failure (provider error, timeout, network error), it returns a `failed` response immediately
- Retry decisions are entirely the caller's responsibility
- This applies to all failure types — there are no silent retries under any condition

**Provider credentials** (phone number ID, access token) are loaded from environment variables — never hardcoded.

---

## 4. Storage

Single storage backend, used for two purposes:

| Purpose | Key Pattern | TTL |
|---|---|---|
| Idempotency | `idempotency:{message_id}` | Configurable (default 24h) |
| Rate limit counters | `ratelimit:{direction}:{key}` | Matches rate window |

**Primary backend: Redis**
- Native `SETNX`, atomic `INCR`, TTL support — required for correct idempotency and rate limiting
- Required for production

**Fallback backend: SQLite**
- For local development or environments without Redis
- Atomic operations emulated via transactions
- Acceptable for low-volume, single-process usage only

**Selection:** Controlled by `STORE_BACKEND=redis|sqlite` config value. Idempotency layer and rate limiter interact with the store through an abstract interface only.

**What is NOT stored:**
- Raw message payloads
- User data beyond phone number (as rate limit key)
- Outbound message history

---

## 5. Error Handling Strategy

**Principle:** Every error is caught, classified, and returned as a structured response. No unhandled exceptions reach the caller.

### Error Classification

| Class | Examples | Action |
|---|---|---|
| Validation error | Missing field, wrong format, bad signature | Return 4xx immediately, log, stop |
| Rate limit error | Inbound/outbound threshold exceeded | Return 429/throttled, log, stop |
| Provider error | WhatsApp API rejection, network timeout | Return 502/failed, log with provider details |
| Internal error | Unhandled exception, unexpected state | Return 500, log full stack trace, stop |
| Store error | Redis/SQLite unreachable | Log warning, degrade gracefully (skip idempotency/rate limiting) |

### Rules

- All errors produce the standardized error response schema (from Phase 2)
- `correlation_id` is always present — generated if not yet available
- Stack traces are logged internally, never exposed in HTTP responses
- Store failures do not crash the service — they degrade specific features
- Provider errors include the raw provider error code in `details`
- Webhook timeout before idempotency write → log `timeout_unsafe`, return HTTP 200
- Webhook timeout after idempotency write → log `timeout`, return HTTP 200

---

## 6. Logging Strategy

**Format:** Structured JSON, one object per log line
**Destination:** stdout
**Level:** Configurable via `LOG_LEVEL` environment variable (`DEBUG`, `INFO`, `WARN`, `ERROR`)

### Log Schema (every event)

```json
{
  "level":              "INFO",
  "timestamp":          "2024-03-10T06:13:21Z",
  "message_id":         "wamid.HBgLOTE5ODc2NTQzMjE",
  "correlation_id":     "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "user_id":            "+91*****3210",
  "direction":          "inbound",
  "status":             "received",
  "normalized_output":  { "...": "..." },
  "raw_payload":        { "...": "..." },
  "error":              null,
  "duration_ms":        42
}
```

### Payload Size Limits & Truncation Rules

| Field | Limit | Behavior on Exceed |
|---|---|---|
| `raw_payload` | 2 KB | Truncated; `"raw_payload_truncated": true` appended to log entry |
| `normalized_output` | 1 KB | Truncated; `"normalized_output_truncated": true` appended |
| `text_body` (within output) | 50 characters | Truncated with `…` suffix |
| `media_metadata` | 512 bytes | Truncated; flag appended |
| Any single log line | 4 KB total | Fields truncated in priority order: raw_payload first, then media_metadata, then normalized_output |

All size limits are configurable via environment variables.

### PII Sanitization Rules

| Field | Treatment |
|---|---|
| `phone_number` in raw payload | Masked: `+91*****3210` |
| `text_body` content | Truncated to 50 chars |
| `name` from contacts | Omitted entirely |
| `access_token` | Never logged under any condition |

### What Gets Logged

| Event | Level |
|---|---|
| Inbound message received and normalized | INFO |
| Duplicate detected | INFO |
| Multi-message payload — extra entries ignored | INFO |
| Validation failure | WARN |
| Rate limit exceeded (global or per-user) | WARN |
| Store unreachable (degraded mode) | WARN |
| Webhook timeout (safe — after idempotency write) | WARN |
| Webhook timeout (unsafe — before idempotency write) | WARN (`timeout_unsafe`) |
| Provider API error | ERROR |
| Internal unhandled exception | ERROR |
| Outbound message accepted | INFO |
| Outbound throttled | WARN |
| Health check — store unreachable | WARN |

---

## Component Interaction Summary

```
POST /webhook
    │
    ├─ RateLimiter.checkGlobal()
    ├─ Validator.verifySignature(rawBody, header)
    ├─ Validator.validatePayload(body)
    ├─ RateLimiter.checkPerUser(phone)
    ├─ IdempotencyLayer.setnx(message_id)
    │       └─ HIT  → return cached, log duplicate
    ├─ Normalizer.normalize(validatedPayload)
    ├─ IdempotencyLayer.writeOutput(message_id, normalizedOutput)
    │       ⚠ Timeout before this = "timeout_unsafe"
    └─ return normalizedOutput, log received

POST /send
    │
    ├─ Validator.validateOutbound(body)
    ├─ RateLimiter.checkOutboundGlobal()
    └─ OutboundClient.send(recipient, text, correlationId)
            └─ single attempt, no retries
            └─ return {status, provider_message_id, error}

GET /health
    └─ Store.ping()
    └─ return {status, service, store, timestamp}
```
