# WhatsApp Interface Module

A standalone, production-ready module for receiving and sending WhatsApp messages via the WhatsApp Cloud API. It handles webhook verification, inbound message normalization, idempotency, rate limiting, and outbound message delivery — all without depending on any other module in the toolkit.

## Prerequisites

- Node.js 18 or higher
- Redis (production) or SQLite (development/testing)

## Setup

```bash
npm install
cp .env.example .env
# Edit .env and fill in required values
```

## Running

**Development (with hot reload):**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

## Testing

```bash
npm test
```

## Endpoints

| Method | Path       | Description                                      |
|--------|------------|--------------------------------------------------|
| GET    | /health    | Health check — returns service and store status  |
| GET    | /webhook   | WhatsApp webhook verification (hub challenge)    |
| POST   | /webhook   | Receive inbound WhatsApp messages                |
| POST   | /send      | Send an outbound WhatsApp message                |

## Environment Variables

| Variable                    | Required | Default                  | Description                                    |
|-----------------------------|----------|--------------------------|------------------------------------------------|
| WHATSAPP_VERIFY_TOKEN       | Yes      | —                        | Token used for webhook verification            |
| WHATSAPP_APP_SECRET         | Yes      | —                        | App secret for HMAC signature verification     |
| WHATSAPP_API_TOKEN          | Yes      | —                        | Bearer token for WhatsApp Cloud API calls      |
| WHATSAPP_PHONE_NUMBER_ID    | Yes      | —                        | Phone number ID from Meta Business dashboard  |
| STORE_BACKEND               | No       | redis                    | Storage backend: `redis` or `sqlite`           |
| REDIS_URL                   | No       | redis://localhost:6379   | Redis connection URL                           |
| SQLITE_PATH                 | No       | ./whatsapp.db            | Path to SQLite database file                   |
| IDEMPOTENCY_TTL_SECONDS     | No       | 86400                    | TTL for idempotency keys (seconds)             |
| RATE_LIMIT_GLOBAL_INBOUND   | No       | 1000                     | Max inbound messages per window (global)       |
| RATE_LIMIT_PER_USER         | No       | 10                       | Max inbound messages per window per user       |
| RATE_LIMIT_OUTBOUND         | No       | 100                      | Max outbound messages per window               |
| RATE_LIMIT_WINDOW_SECONDS   | No       | 60                       | Rate limit sliding window duration (seconds)  |
| WEBHOOK_TIMEOUT_SECONDS     | No       | 5                        | Max time to process an inbound webhook         |
| OUTBOUND_TIMEOUT_SECONDS    | No       | 10                       | Max time to wait for provider response         |
| LOG_LEVEL                   | No       | INFO                     | Log level: DEBUG, INFO, WARN, or ERROR         |
| LOG_MAX_PAYLOAD_BYTES       | No       | 2048                     | Max bytes logged for raw payloads              |
| PORT                        | No       | 8000                     | HTTP port the server listens on                |

> **Note:** SQLite is intended for local development and testing only. Use Redis in production for proper distributed rate limiting and idempotency guarantees.
