# Ledger App — End-to-End Setup Guide

## Overview

A WhatsApp-based personal finance ledger. Users send text messages to record transactions, check balances, view summaries, look up party ledgers, or delete entries. Supports both structured (deterministic) and AI-assisted parsing modes.

---

## Architecture

```
WhatsApp User
     |
     | (sends message)
     v
Meta Cloud API
     |
     | (webhook POST /webhook)
     v
apps/ledger/src/server.ts
     |
     | receive() → ingestion-module (normalise)
     v
apps/ledger/src/handler.ts → handleLedgerMessage()
     |
     | runFlow(intentRouterFlow, ...)
     |    → structured parse OR AI classify/extract
     |    → resolveRouting() → next flow name
     |
     |--- ledger-entry    → storage + communication
     |--- ledger-balance  → storage + communication
     |--- ledger-summary  → storage + communication
     |--- ledger-party    → storage + communication
     |--- ledger-delete   → storage + communication
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js >= 18 | Required by all modules |
| Google Cloud service account | With Sheets API enabled and sheet shared with the service account |
| Meta WhatsApp Business account | With a phone number and permanent token |
| Public HTTPS URL | Use ngrok for local dev |

---

## Step 1 — Google Sheets Setup

1. Create a new Google Sheet.
2. Rename the first tab to `Ledger`.
3. Add a header row in row 1:

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| Date | Type | Amount | Party | Category | User |

4. Share the sheet with your Google service account email (Editor access).
5. Copy the Sheet ID from the URL:
   ```
   https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
   ```

---

## Step 2 — Environment Variables

Create or edit **`apps/ledger/.env`**:

```env
# Required
LEDGER_SHEET_ID=<your-google-sheet-id>
LEDGER_OWNER_PHONE=<E164-phone-eg-+919999999999>

# Communication provider
COMM_PROVIDER=meta
WHATSAPP_PHONE_NUMBER_ID=<your-phone-number-id>
WHATSAPP_ACCESS_TOKEN=<your-api-token>

# Storage
GOOGLE_SERVICE_ACCOUNT_JSON=<json-string>

# Webhook
WEBHOOK_VERIFY_TOKEN=<your-verify-token>

# Mode (optional — default: structured)
LEDGER_MODE=structured
# LEDGER_MODE=ai

# AI provider (optional — only used when LEDGER_MODE=ai, default: anthropic)
# LEDGER_AI_PROVIDER=anthropic
# LEDGER_AI_PROVIDER=openai
# LEDGER_AI_PROVIDER=local
# LEDGER_AI_PROVIDER=nvidia

# AI keys (only needed if using AI mode)
# ANTHROPIC_API_KEY=...
# OPENAI_API_KEY=...
# NVIDIA_API_KEY=...
```

---

## Step 3 — Install Dependencies

```bash
cd flows/ledger && npm install
cd ../../apps/ledger && npm install
```

---

## Step 4 — Run the App

```bash
cd apps/ledger
npm run dev
```

The server starts on `PORT` (default `3001`).

---

## Step 5 — Expose Locally with ngrok

```bash
ngrok http 3001
```

Copy the HTTPS forwarding URL, e.g. `https://abc123.ngrok-free.app`.

---

## Step 6 — Configure Meta Webhook

1. Go to Meta Developer Console → your app → WhatsApp → Configuration.
2. Set **Webhook URL** to: `https://abc123.ngrok-free.app/webhook`
3. Set **Verify Token** to the value of `WEBHOOK_VERIFY_TOKEN` in your `.env`.
4. Subscribe to the `messages` field.

---

## Message Commands (Structured Mode)

| Message | Command | Notes |
|---|---|---|
| `add credit 5000 rahul` | record credit | `add <credit\|debit> <amount> <party> [category]` |
| `add debit 1200 groceries food` | record debit with category | |
| `add credit 2.5k aman` | supports `k` suffix | `2.5k` = 2500 |
| `balance` | show net balance | all-time credits vs debits |
| `summary` | today's transactions | filters by current date |
| `ledger rahul` | party ledger | shows all entries for a party |
| `delete last` | soft-delete | blanks the most recent entry |

In AI mode, natural language is also accepted: `"I got 5000 from rahul"`, `"paid electricity bill 800"`, etc.

---

## Sheet Row Written (per entry)

| Column | Value |
|---|---|
| A — Date | YYYY-MM-DD |
| B — Type | `credit` or `debit` |
| C — Amount | Numeric string |
| D — Party | Party name |
| E — Category | Category (empty if not provided) |
| F — User | E.164 phone number of sender |

---

## Troubleshooting

| Problem | Check |
|---|---|
| Webhook verification fails | `WEBHOOK_VERIFY_TOKEN` in `.env` matches Meta console |
| No reply received | `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` are correct |
| Sheet not updating | Service account has Editor access; `LEDGER_SHEET_ID` is correct |
| `GOOGLE_SERVICE_ACCOUNT_JSON` error | Ensure the value is a valid JSON string (no newlines) |
| AI mode not classifying | Check `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` is set and `LEDGER_MODE=ai` |
