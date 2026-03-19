# Module 1: WhatsApp Interface Module
## Phase 2: Contract Design

**Timestamp:** 2026-03-18
**Version:** v2 (Final)

---

### Changelog Summary (This File)

| Version | Changes |
|---|---|
| v1 | Initial contracts — inbound raw schema, normalized output, outbound request/response, error schema with 3–5 examples each |
| v2 | Added multi-message handling (process first only), ordering disclaimer, `correlation_id` always required in errors, replaced `"sent"` with `"accepted"` in outbound status, added webhook timeout constraint (default 5s) |

---

## 1. Inbound Webhook — Raw Input Contract

**Expected Content-Type:** `application/json`
**Expected Header:** `X-Hub-Signature-256: sha256=<hmac>`

### Raw Payload Schema

```json
{
  "object": "whatsapp_business_account",        // string, required
  "entry": [                                     // array, required, min 1 item
    {
      "id": "string",                            // string, required — WABA ID
      "changes": [                               // array, required, min 1 item
        {
          "value": {
            "messaging_product": "whatsapp",     // string, required, must equal "whatsapp"
            "metadata": {
              "display_phone_number": "string",  // string, required
              "phone_number_id": "string"        // string, required
            },
            "contacts": [                        // array, optional
              {
                "profile": {
                  "name": "string"               // string, optional
                },
                "wa_id": "string"                // string, required if contacts present
              }
            ],
            "messages": [                        // array, optional (absent on status updates)
              {
                "id": "string",                  // string, required — provider message_id
                "from": "string",                // string, required — sender phone (no +)
                "timestamp": "string",           // string, required — Unix epoch string
                "type": "string",                // string, required — "text"|"image"|"audio"|etc.
                "text": {
                  "body": "string"               // string, required if type == "text"
                }
              }
            ]
          },
          "field": "messages"                    // string, required, must equal "messages"
        }
      ]
    }
  ]
}
```

### Multi-Message Handling (v1)

When `messages[]` contains more than one entry:

- **Only the first message (`messages[0]`) is processed**
- All subsequent entries are silently ignored
- The response reflects only the first message
- Ignored entries are noted in the log with `status: "ignored"` and their `message_id`

> **Ordering Disclaimer:** Message ordering within a webhook payload — and across separate webhook deliveries — is **not guaranteed by the WhatsApp provider**. This module does not attempt to enforce or correct message ordering. Callers must not assume messages arrive or are processed in send order.

### Validation Rules

| Rule | Behavior on Failure |
|---|---|
| `object` != `"whatsapp_business_account"` | Reject — HTTP 400 |
| `entry` missing or empty | Reject — HTTP 400 |
| `changes[].field` != `"messages"` | Reject — HTTP 400 |
| `messaging_product` != `"whatsapp"` | Reject — HTTP 400 |
| `messages[0].id` missing | Reject — HTTP 400 |
| `messages[0].from` missing | Reject — HTTP 400 |
| `messages` array absent | Accepted — status update, ignored, HTTP 200 |
| Signature header invalid | Reject — HTTP 401 |
| Unrecognized top-level structure | Reject — HTTP 400 |
| `messages[]` has multiple entries | Process first only, ignore rest, HTTP 200 |

### Timeout Constraint

- The module **must respond to every webhook request within a configurable timeout**
- Default: **5 seconds** from receipt to HTTP response
- If internal processing cannot complete within the timeout, return HTTP `200` immediately to prevent provider retry
- If timeout fires **after** idempotency lock is acquired but **before** the normalized output is written, log with `status: "timeout_unsafe"` — the event may be re-processed on provider retry
- If timeout fires after the idempotency write is complete, log with `status: "timeout"` — safe, no re-processing risk
- Timeout value is set via configuration — not hardcoded

---

### Raw Payload Examples

**Example 1 — Inbound text message**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550001234",
          "phone_number_id": "106540352242922"
        },
        "contacts": [{
          "profile": { "name": "Arjun Mehta" },
          "wa_id": "919876543210"
        }],
        "messages": [{
          "id": "wamid.HBgLOTE5ODc2NTQzMjE",
          "from": "919876543210",
          "timestamp": "1710000000",
          "type": "text",
          "text": { "body": "What are your opening hours?" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

**Example 2 — Multiple messages in payload (v1 behavior)**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550001234",
          "phone_number_id": "106540352242922"
        },
        "messages": [
          {
            "id": "wamid.FIRST001",
            "from": "919876543210",
            "timestamp": "1710000000",
            "type": "text",
            "text": { "body": "First message" }
          },
          {
            "id": "wamid.SECOND002",
            "from": "919876543210",
            "timestamp": "1710000005",
            "type": "text",
            "text": { "body": "Second message" }
          }
        ]
      },
      "field": "messages"
    }]
  }]
}
```
> `wamid.FIRST001` is processed. `wamid.SECOND002` is ignored and logged.

**Example 3 — Inbound image message (media, unsupported in v1)**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550001234",
          "phone_number_id": "106540352242922"
        },
        "messages": [{
          "id": "wamid.XYZLOTEImageExample",
          "from": "919812345678",
          "timestamp": "1710000120",
          "type": "image",
          "image": {
            "id": "media-id-98765",
            "mime_type": "image/jpeg",
            "sha256": "abc123hash",
            "caption": "Check this out"
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

**Example 4 — Status update only (no messages array)**
```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "102290129340398",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "15550001234",
          "phone_number_id": "106540352242922"
        },
        "statuses": [{
          "id": "wamid.HBgLOTE5ODc2",
          "status": "delivered",
          "timestamp": "1710000200",
          "recipient_id": "919876543210"
        }]
      },
      "field": "messages"
    }]
  }]
}
```

---

## 2. Normalized Message Output Schema

Returned as the HTTP response body after successful inbound processing.

```json
{
  "message_id":     "string",    // required — provider-assigned unique ID
  "correlation_id": "string",    // required — module-generated UUID for tracing
  "phone_number":   "string",    // required — sender in E.164 format (e.g. "+919876543210")
  "timestamp":      "string",    // required — UTC ISO 8601 (e.g. "2024-03-10T06:13:20Z")
  "message_type":   "string",    // required — "text" | "unsupported"
  "text_body":      "string",    // optional — present only when message_type == "text"
  "media_metadata": "object",    // optional — raw provider media fields, unprocessed
  "status":         "string",    // required — "received" | "duplicate"
  "received_at":    "string"     // required — UTC ISO 8601, when module processed the event
}
```

### Field Rules

| Field | Type | Required | Notes |
|---|---|---|---|
| `message_id` | string | yes | Copied from `messages[0].id` |
| `correlation_id` | string | yes | UUID generated by this module |
| `phone_number` | string | yes | E.164, always includes `+` prefix |
| `timestamp` | string | yes | Converted from Unix epoch to ISO 8601 UTC |
| `message_type` | string | yes | Only `"text"` or `"unsupported"` in v1 |
| `text_body` | string | no | Omitted if `message_type` != `"text"` |
| `media_metadata` | object | no | Omitted for text messages |
| `status` | string | yes | `"received"` or `"duplicate"` |
| `received_at` | string | yes | Processing time, not message send time |

> **Note:** `timestamp` reflects when the sender sent the message per the provider. `received_at` reflects when this module processed it. These will differ. Neither implies ordering guarantees.

---

### Normalized Output Examples

**Example 1 — Text message, first occurrence**
```json
{
  "message_id": "wamid.HBgLOTE5ODc2NTQzMjE",
  "correlation_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "phone_number": "+919876543210",
  "timestamp": "2024-03-10T06:13:20Z",
  "message_type": "text",
  "text_body": "What are your opening hours?",
  "status": "received",
  "received_at": "2024-03-10T06:13:21Z"
}
```

**Example 2 — Duplicate text message**
```json
{
  "message_id": "wamid.HBgLOTE5ODc2NTQzMjE",
  "correlation_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "phone_number": "+919876543210",
  "timestamp": "2024-03-10T06:13:20Z",
  "message_type": "text",
  "text_body": "What are your opening hours?",
  "status": "duplicate",
  "received_at": "2024-03-10T06:13:21Z"
}
```

**Example 3 — Unsupported media message**
```json
{
  "message_id": "wamid.XYZLOTEImageExample",
  "correlation_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "phone_number": "+919812345678",
  "timestamp": "2024-03-10T06:15:00Z",
  "message_type": "unsupported",
  "media_metadata": {
    "type": "image",
    "image": {
      "id": "media-id-98765",
      "mime_type": "image/jpeg",
      "sha256": "abc123hash",
      "caption": "Check this out"
    }
  },
  "status": "received",
  "received_at": "2024-03-10T06:15:01Z"
}
```

**Example 4 — Text message, US number**
```json
{
  "message_id": "wamid.USExampleMessage001",
  "correlation_id": "c9d8e7f6-a5b4-3c2d-1e0f-9a8b7c6d5e4f",
  "phone_number": "+14155552671",
  "timestamp": "2024-03-10T14:22:10Z",
  "message_type": "text",
  "text_body": "I need help with my order.",
  "status": "received",
  "received_at": "2024-03-10T14:22:11Z"
}
```

---

## 3. Outbound Send Request Schema

```json
{
  "recipient":      "string",   // required — E.164 phone number
  "text":           "string",   // required — message body, non-empty, max 4096 chars
  "correlation_id": "string"    // required — caller-provided UUID for tracing
}
```

### Field Rules

| Field | Type | Required | Constraints |
|---|---|---|---|
| `recipient` | string | yes | Must match E.164 format: `+[country code][number]` |
| `text` | string | yes | Non-empty, max 4096 characters (WhatsApp API limit) |
| `correlation_id` | string | yes | UUID format, provided by caller |

---

### Outbound Request Examples

**Example 1 — Order confirmation**
```json
{
  "recipient": "+919876543210",
  "text": "Your order #4521 has been confirmed and will be delivered by tomorrow.",
  "correlation_id": "req-uuid-001-aabb-ccdd-eeff"
}
```

**Example 2 — Appointment reminder**
```json
{
  "recipient": "+14155552671",
  "text": "Reminder: Your appointment is scheduled for March 11 at 10:00 AM.",
  "correlation_id": "req-uuid-002-1122-3344-5566"
}
```

**Example 3 — Simple reply**
```json
{
  "recipient": "+447911123456",
  "text": "Thank you for contacting us. We will get back to you shortly.",
  "correlation_id": "req-uuid-003-aabbcc-ddeeff-001"
}
```

**Example 4 — Invalid request (missing correlation_id)**
```json
{
  "recipient": "+919876543210",
  "text": "Hello!"
}
```
> Module rejects with HTTP 400, error code `MISSING_FIELD`.

---

## 4. Outbound Send Response Schema

```json
{
  "correlation_id":       "string",   // required — echoed from request
  "provider_message_id":  "string",   // optional — set on accepted, absent on failure
  "status":               "string",   // required — "accepted" | "failed" | "throttled"
  "error":                "object"    // optional — present only when status != "accepted"
}
```

### Status Values

| Status | Meaning |
|---|---|
| `accepted` | Message was accepted by the WhatsApp API. **Does not mean delivered to recipient.** Delivery is managed by the provider asynchronously. |
| `failed` | WhatsApp API rejected the request or an internal error occurred. Message was not sent. |
| `throttled` | Outbound rate limit was reached. Message was not sent. Caller should retry after delay. |

### Field Rules

| Field | Type | Required | Notes |
|---|---|---|---|
| `correlation_id` | string | yes | Always echoed from request |
| `provider_message_id` | string | no | Returned by WhatsApp API only on `accepted` |
| `status` | string | yes | `"accepted"`, `"failed"`, or `"throttled"` |
| `error` | object | no | Present only when `status` != `"accepted"` |

---

### Outbound Response Examples

**Example 1 — Accepted by API**
```json
{
  "correlation_id": "req-uuid-001-aabb-ccdd-eeff",
  "provider_message_id": "wamid.OUTBOUNDmsgABC123",
  "status": "accepted"
}
```

**Example 2 — Failed (provider rejection)**
```json
{
  "correlation_id": "req-uuid-002-1122-3344-5566",
  "status": "failed",
  "error": {
    "code": "PROVIDER_ERROR",
    "message": "Recipient phone number not registered on WhatsApp.",
    "provider_error_code": 131026
  }
}
```

**Example 3 — Throttled**
```json
{
  "correlation_id": "req-uuid-003-aabbcc-ddeeff-001",
  "status": "throttled",
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Outbound rate limit reached. Message was not sent.",
    "retry_after_seconds": 5
  }
}
```

---

## 5. Error Response Schema

```json
{
  "error":          true,        // boolean, always true
  "code":           "string",    // required — machine-readable error code
  "message":        "string",    // required — human-readable description
  "correlation_id": "string",    // required — ALWAYS present; module-generated if not yet available
  "message_id":     "string",    // optional — provider message ID if available at point of failure
  "details":        "object"     // optional — additional context (provider codes, field names)
}
```

### `correlation_id` Guarantee

`correlation_id` is **always present** in every error response without exception:
- If the request included a `correlation_id`, it is echoed back
- If the request did not include one, the module generates a new UUID for the response
- If the error occurs before the request body is parsed, a fresh UUID is generated

### Standard Error Codes

| Code | HTTP Status | Meaning |
|---|---|---|
| `INVALID_PAYLOAD` | 400 | Payload structure does not match expected schema |
| `MISSING_FIELD` | 400 | A required field is absent |
| `INVALID_FORMAT` | 400 | A field value fails format validation |
| `SIGNATURE_INVALID` | 401 | HMAC signature verification failed |
| `RATE_LIMIT_EXCEEDED` | 429 | Inbound or outbound rate limit hit |
| `PROVIDER_ERROR` | 502 | WhatsApp API returned an error |
| `INTERNAL_ERROR` | 500 | Unexpected internal failure |

---

### Error Response Examples

**Example 1 — Invalid payload structure**
```json
{
  "error": true,
  "code": "INVALID_PAYLOAD",
  "message": "Missing required field: entry[0].changes[0].value.messaging_product",
  "correlation_id": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Example 2 — Signature verification failure (module generates correlation_id)**
```json
{
  "error": true,
  "code": "SIGNATURE_INVALID",
  "message": "X-Hub-Signature-256 header does not match computed HMAC.",
  "correlation_id": "9f8e7d6c-5b4a-3210-fedc-ba9876543210"
}
```

**Example 3 — Rate limit exceeded (inbound)**
```json
{
  "error": true,
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests from this sender. Retry after 30 seconds.",
  "correlation_id": "c9d8e7f6-a5b4-3c2d-1e0f-9a8b7c6d5e4f",
  "message_id": "wamid.HBgLOTE5ODc2NTQzMjE",
  "details": {
    "retry_after_seconds": 30,
    "sender": "+919876543210"
  }
}
```

**Example 4 — Missing required field (outbound)**
```json
{
  "error": true,
  "code": "MISSING_FIELD",
  "message": "Field 'correlation_id' is required.",
  "correlation_id": "b3c4d5e6-f7a8-9012-bcde-f01234567890",
  "details": {
    "field": "correlation_id"
  }
}
```

**Example 5 — Internal error**
```json
{
  "error": true,
  "code": "INTERNAL_ERROR",
  "message": "An unexpected error occurred. The request may be retried.",
  "correlation_id": "a0b1c2d3-e4f5-6789-abcd-ef0123456789"
}
```

---

## Contract Summary

| Contract | Direction | Method | Endpoint |
|---|---|---|---|
| Raw webhook input | Provider → Module | `POST` | `/webhook` |
| Normalized message output | Module → Caller | JSON response body | — |
| Webhook verification | Provider → Module | `GET` | `/webhook` |
| Outbound send request | Caller → Module | `POST` | `/send` |
| Outbound send response | Module → Caller | JSON response body | — |
| Error response | Any failure | JSON response body | — |

### HTTP Response Code Reference

| Scenario | HTTP Status |
|---|---|
| Successful processing | `200` |
| Duplicate event | `200` |
| Invalid payload / schema mismatch | `400` |
| Signature verification failure | `401` |
| Rate limit exceeded | `429` |
| Internal processing error | `500` |
| Upstream API failure (outbound) | `502` |
