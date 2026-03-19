# Module 1: WhatsApp Interface Module
## Phase 1: Module Definition

**Timestamp:** 2026-03-18
**Version:** v3 (Final)

---

### Changelog Summary (This File)

| Version | Changes |
|---|---|
| v1 | Initial definition — purpose, responsibilities, boundaries, 4 scenarios |
| v2 | Added normalization spec (E.164, fields), idempotency, output behavior, structured logging, media handling (v1) |
| v3 | Added payload validation & version handling, HTTP response strategy, persistent idempotency store, rate limiting, outbound correlation_id + provider_message_id tracking |

---

### Purpose

Provide a standardized interface for receiving and sending WhatsApp messages. This module acts as the boundary between WhatsApp (via webhook/API) and any downstream caller — handling raw message ingestion, payload validation, normalization, idempotency, rate limiting, and outbound delivery. It returns a clean, predictable output with no side effects beyond logging.

---

### Responsibilities

---

#### 1. Inbound — Receive, Validate & Normalize

- Receive incoming WhatsApp messages via webhook (HTTP POST)
- Verify webhook signature to confirm the request originates from the provider

**Payload Structure Validation**
- Explicitly validate that the incoming payload matches the expected WhatsApp Business Cloud API structure
- Check for required fields: `object`, `entry`, `changes`, `value`, `messages`
- Validate payload version compatibility — if the structure is unrecognized or fields are missing/unexpected, fail safely:
  - Return `400` with a structured error
  - Log the raw sanitized payload and reason for rejection
  - Do NOT attempt partial parsing of unknown formats

**Normalization** (only after validation passes)
- Extract and normalize:
  - `message_id` — unique identifier from the provider
  - `timestamp` — normalized to UTC ISO 8601
  - `message_type` — `text`, or `unsupported` for all other types
  - `phone_number` — sender's number, standardized to **E.164 format**
  - `text_body` — message content (text messages only)
  - `media_metadata` — raw provider fields, passed through unprocessed (v1)
- Return the normalized message as a structured JSON response body

---

#### 2. Idempotency

- Detect duplicate webhook events by `message_id` before processing
- Idempotency store **must be persistent** — in-memory storage is not acceptable
  - Acceptable backends: Redis, SQLite, or any configurable key-value store
  - Store must survive process restarts
- On duplicate detection:
  - Return the previously stored normalized output
  - Return HTTP `200` (not an error — duplicate handling is expected behavior)
  - Log with `status: "duplicate"` — no re-processing, no side effects
- Idempotency store entries should have a configurable TTL (default: 24 hours)

---

#### 3. HTTP Response Strategy

| Scenario | HTTP Status | Notes |
|---|---|---|
| Successful processing | `200` | Normalized message returned |
| Duplicate event | `200` | Previously stored output returned |
| Invalid payload / schema mismatch | `400` | Structured error body returned |
| Signature verification failure | `401` | Request rejected |
| Rate limit exceeded | `429` | Retry-After header included |
| Internal processing error | `500` | Retry-safe — provider may re-deliver |
| Upstream API failure (outbound) | `502` | Structured error with provider details |

All error responses return a consistent JSON error body:
```json
{
  "error": true,
  "code": "INVALID_PAYLOAD",
  "message": "...",
  "message_id": "...",
  "correlation_id": "..."
}
```

---

#### 4. Rate Limiting

**Inbound — Two-Tier**
- **Tier 1 (Global):** Applied before payload parsing — protects against raw request floods regardless of sender
- **Tier 2 (Per-User):** Applied after phone number is extracted — protects against a single sender flooding the service
- Both tiers are configurable (max requests per time window)
- Requests exceeding either limit return `429` with a `Retry-After` header
- Rate limit counters backed by the same persistent store used for idempotency

**Outbound**
- Apply throttling protection on outbound message sends
- Configurable max send rate (e.g., requests per second/minute)
- Queue or reject excess outbound requests gracefully — never silently drop
- Log throttle events with `status: "throttled"`

---

#### 5. Outbound — Send Message & Tracking

- Accept input:
  - `recipient` — phone number in E.164 format
  - `text` — message string
  - `correlation_id` — caller-provided identifier for end-to-end tracing
- Deliver the message via the WhatsApp Business Cloud API
- Return a structured delivery status response:
  - `correlation_id` — echoed back from the request
  - `provider_message_id` — message ID returned by the WhatsApp API
  - `status` — `accepted` or `failed`
  - `error` — structured error details if applicable
- `correlation_id` is included in all logs for this send operation

---

#### 6. Webhook Verification

- Handle GET-based webhook verification handshake from the provider
- Validate `hub.verify_token` against configured value
- Respond with `hub.challenge` on success, `403` on mismatch

---

#### 7. Logging

Log the following fields as structured JSON to stdout for every event:

| Field | Description |
|---|---|
| `message_id` | Provider message identifier |
| `correlation_id` | End-to-end trace identifier |
| `user_id` | Sender phone number (E.164) |
| `raw_payload` | Sanitized — PII fields masked or truncated |
| `normalized_output` | Full normalized JSON produced |
| `status` | `received`, `duplicate`, `accepted`, `failed`, `throttled`, `rejected`, `timeout`, `timeout_unsafe`, `ignored` |
| `error` | Structured error object if applicable |
| `timestamp` | Log event time in UTC ISO 8601 |

---

### Boundaries — What This Module Does NOT Do

- Does NOT interpret or act on message content
- Does NOT apply business or routing logic
- Does NOT persist messages to a database (idempotency store is not a message store)
- Does NOT publish to an event bus or dispatch to external systems
- Does NOT call any other module
- Does NOT manage conversation state or user sessions
- Does NOT process media files — passed through as raw metadata only (v1)
- Does NOT authenticate end users — only verifies provider webhook signatures

---

### Media Handling (v1)

- **Text messages** — fully supported: parsed, normalized, returned
- **Media messages** (image, audio, video, document, sticker):
  - `message_type` set to `"unsupported"`
  - Raw media metadata included as-is under `media_metadata`
  - No download, no processing, no error thrown

---

### Provider Assumption

This module is designed for the **WhatsApp Business API via Meta (Cloud API)**. Provider-specific logic is isolated to an adapter layer to allow future substitution.

---

### Example Scenarios

| # | Scenario | Outcome |
|---|---|---|
| 1 | Valid inbound text message | Normalized JSON returned, `status: received` |
| 2 | Duplicate webhook (same `message_id`) | Cached output returned, `status: duplicate`, HTTP 200 |
| 3 | Inbound media message | `message_type: unsupported`, metadata passed through |
| 4 | Unknown/malformed payload structure | Rejected, HTTP 400, logged |
| 5 | Signature verification failure | Rejected, HTTP 401 |
| 6 | Sender exceeds rate limit | HTTP 429 with Retry-After |
| 7 | Outbound send with `correlation_id` | `provider_message_id` + `correlation_id` returned |
| 8 | Outbound throttle exceeded | Request rejected gracefully, `status: throttled`, logged |
