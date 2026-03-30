# Ledger App — Use Case Document

## Overview

The Ledger App is a WhatsApp-based personal finance tracker. Users send plain-text messages to record credit/debit transactions, query balances, view daily summaries, look up transaction history by party, and delete their last entry. No separate app or login is required — the system works entirely through WhatsApp.

The app supports two parsing modes:
- **Structured mode** — deterministic keyword-based parsing (exact command syntax required)
- **AI mode** — LLM-powered NLP that understands natural language input before dispatching the same flows

Currently configured in **AI mode using NVIDIA NIM (Llama 3.1 8B)**.

---

## Business Context

### Problem Statement

Individuals managing informal financial records (money lent, received, daily expenses) rely on manual spreadsheets or memory. Updating these requires opening a separate tool, which creates friction and leads to missed entries.

### Solution

A WhatsApp chatbot that acts as a personal ledger. Users send messages like "add credit 5000 rahul" or "paid 1200 to groceries" and the system records, queries, and confirms — all within the chat interface.

### Stakeholders

| Role | Responsibility | System Interaction |
|------|---------------|-------------------|
| User (Owner) | Records and queries their transactions | Sends WhatsApp messages to the bot |
| System (Bot) | Parses intent, routes to correct flow, responds | Webhook-triggered per message |

> Unlike the mining app, this system is **single-user**: all transactions are scoped to the sender's WhatsApp phone number. Each user has their own isolated view of the shared sheet filtered by their `User` column.

---

## Functional Requirements

### FR-1: Record a Transaction (add)

- User sends a message containing transaction details (type, amount, party, optional category)
- System parses the intent and fields
- System checks for duplicates (same type + amount + party + user across any date)
- If no duplicate: writes to sheet, confirms to user
- If duplicate found: skips write, warns user

**Structured format:**
```
add credit 5000 rahul
add debit 1200 groceries food
```

**AI-mode examples (natural language):**
```
paid 1500 to rahul
received 5000 from ravi
gave 800 for groceries
```

**Supported type aliases:**
| Input word | Normalized as |
|------------|--------------|
| credit, received, got | credit |
| debit, paid, gave | debit |

**Amount parsing:** Supports `k` suffix (e.g., `5k` → 5000). Rejects zero or negative.

### FR-2: Check Balance

- User sends `balance`
- System reads all their transactions, computes total credits, total debits, and net balance
- Responds with a formatted balance summary

### FR-3: Daily Summary

- User sends `summary` or `summary today`
- System reads today's transactions for the user
- Lists each entry with +/− prefix, totals credits, debits, and net for the day

### FR-4: Party Ledger

- User sends `ledger <party_name>`
- System fetches all transactions matching that party name (case-insensitive)
- Shows a chronological list with per-transaction amounts and dates, plus totals

### FR-5: Delete Last Entry

- User sends `delete last`
- System finds the user's most recent transaction row
- Soft-deletes it (overwrites all columns with blank strings — row stays in sheet)
- Confirms with the details of what was deleted
- If no entries exist, responds with "No entries found to delete"

### FR-6: Invalid Input Handling

In structured mode: sends a help menu listing all valid commands.
In AI mode: attempts LLM classification; if extraction fails, prompts with an example.

---

## User Interaction Examples

| User Message | Intent | Response |
|-------------|--------|----------|
| `add credit 5000 rahul` | Record credit | "Entry recorded. Credit: 5000, Party: rahul" |
| `paid 800 groceries` | Record debit (AI) | "Entry recorded. Debit: 800, Party: groceries" |
| `balance` | Check balance | Balance summary with credits, debits, net |
| `summary` | Today's summary | List of today's entries + totals |
| `ledger rahul` | Party ledger | All transactions with rahul + net |
| `delete last` | Delete last entry | Confirmation of deleted row |
| `hello` (structured mode) | Unknown | Help menu |

---

## Technical Architecture

### System Components

```
WhatsApp (Meta)
      │
      ▼
POST /webhook  ←── Express server (apps/ledger/src/server.ts)
      │
      ▼
ingestion-module (normalize Meta payload → NormalizedEvent)
      │
      ▼
handleLedgerMessage()  ←── apps/ledger/src/handler.ts
      │
      ├─── Step 1: intentRouterFlow  ←── flows/ledger/intent-router/flow.ts
      │         │
      │         ├── [structured] deterministic parsing (no I/O)
      │         └── [ai mode]   classify-intent → extract-transaction (intelligence-module)
      │
      ├─── resolveRouting() → determines nextFlow + payload
      │
      └─── Step 2: Dispatch to sub-flow
               ├── ledger-entry   (flows/ledger/ledger-entry/flow.ts)
               ├── ledger-balance (flows/ledger/ledger-balance/flow.ts)
               ├── ledger-summary (flows/ledger/ledger-summary/flow.ts)
               ├── ledger-party   (flows/ledger/ledger-party/flow.ts)
               └── ledger-delete  (flows/ledger/ledger-delete/flow.ts)
```

### Module Usage

| Module | Used For | Operation |
|--------|----------|-----------|
| `ingestion-module` | Parse Meta webhook payload | `receive({ source: 'whatsapp', provider: 'meta', payload })` |
| `intelligence-module` | AI intent classification + field extraction | `run({ provider, task: 'classification'/'extraction', ... })` |
| `storage-module` | Read/write/query/update Google Sheets | `execute({ provider: 'sheets', operation, resource: sheetId })` |
| `communication-module` | Send WhatsApp replies | `execute({ to, message })` |
| `engine-module` | Orchestrate all flows | `runFlow(flow, context, modules)` |

---

## Flow Architecture

### Dual-Mode Design

The intent router runs first on every message. It tries structured parsing before invoking AI, even in AI mode — structured input always bypasses the LLM.

```
Message received
      │
      ▼
detectStructured(text) → match?
      │
     YES ──────────────────────────────────────────► resolveRouting (structured payload)
      │
      NO
      │
   mode = 'ai'?
      │
     NO ──────────────────────────────────────────► send-invalid (help menu)
      │
     YES
      │
      ▼
classify-intent (LLM)
      │
  label = 'add'?
      │
     YES → extract-transaction (LLM) → resolveRouting (AI payload)
      │
      NO ─────────────────────────────────────────► resolveRouting (non-add AI payload)
```

---

### Flow 1: `intent-router` (`flows/ledger/intent-router/flow.ts`)

**Purpose:** Parse message intent and route to the correct sub-flow.

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `classify-intent` | intelligence | only if `needsAI` | Classify message into: `add / balance / summary / ledger / delete` |
| `extract-transaction` | intelligence | only if AI mode AND classify = `add` | Extract fields: `type, amount, party, category` |
| `send-invalid` | communication | only if `!validInput` (structured mode, no match) | Send help menu to user |

**Command → Flow mapping:**
```
add     → ledger-entry
balance → ledger-balance
summary → ledger-summary
ledger  → ledger-party
delete  → ledger-delete
```

---

### Flow 2: `ledger-entry` (`flows/ledger/ledger-entry/flow.ts`)

**Purpose:** Validate and record a new credit or debit transaction.

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `check-duplicate` | storage | always | Query Sheets for matching Type + Amount + Party + User |
| `write-to-sheet` | storage | only if no duplicate | Append new row to `Ledger` tab |
| `send-success` | communication | only if no duplicate | Confirm entry to user |
| `send-duplicate-warning` | communication | only if duplicate found | Warn user, skip write |

**Pre-flow validation** (`buildInitialContext`): Parses `add <type> <amount> <party> [category]`. Returns `{ ok: false }` if format is invalid.

**Default category:** `expense` for debit, `income` for credit (if not provided).

---

### Flow 3: `ledger-balance` (`flows/ledger/ledger-balance/flow.ts`)

**Purpose:** Compute and return overall balance across all transactions.

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `read-sheet` | storage | always | Read all rows from `Ledger` tab |
| `send-balance` | communication | always | Sum credits, debits, compute net; send to user |

> Note: Reads ALL rows in the sheet — does not filter by user. All users currently share the same sheet. If multi-user isolation is needed, filtering by `User` column would be required.

---

### Flow 4: `ledger-summary` (`flows/ledger/ledger-summary/flow.ts`)

**Purpose:** Show all of today's transactions with net totals.

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `read-sheet` | storage | always | Read all rows from `Ledger` tab |
| `send-summary` | communication | always | Filter by today's date, format and send list |

---

### Flow 5: `ledger-party` (`flows/ledger/ledger-party/flow.ts`)

**Purpose:** Show all transactions with a specific party.

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `read-sheet` | storage | always | Read all rows from `Ledger` tab |
| `send-party-ledger` | communication | always | Filter by party name (case-insensitive), format and send |

---

### Flow 6: `ledger-delete` (`flows/ledger/ledger-delete/flow.ts`)

**Purpose:** Soft-delete the user's most recent transaction.

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `read-sheet` | storage | always | Read all rows from `Ledger` tab |
| `overwrite-last-row` | storage | only if user has rows | Overwrite last matching row with 6 blank strings |
| `send-confirmation` | communication | only if overwrite ran | Confirm deleted entry details |
| `send-no-entries` | communication | only if overwrite skipped | "No entries found to delete" |

**Soft delete mechanism:** Row is blanked in-place using `update` operation with `rowIndex`. The row is not removed from the sheet — it becomes an empty row.

---

## Data Model

### Google Sheets Schema — `Ledger` tab

| Column | Header | Type | Description |
|--------|--------|------|-------------|
| A | Date | ISO 8601 string | Transaction date (YYYY-MM-DD) |
| B | Type | `credit` / `debit` | Direction of transaction |
| C | Amount | numeric string | Transaction amount |
| D | Party | string | Person or entity involved |
| E | Category | string | Optional tag (expense, income, etc.) |
| F | User | string | Sender's WhatsApp phone number (E.164) |

> The sheet uses a **named range `Ledger`** (not `Sheet1`). The first row must be the header row — all read/query operations use it for column name mapping.

### Duplicate Check Query

```typescript
{
  provider: 'sheets',
  operation: 'query',
  resource: sheetId,
  query: { Type: p.type, Amount: String(p.amount), Party: p.party, User: p.user },
  options: { range: 'Ledger' }
}
```

Matches across all dates — same transaction submitted on different days would still be flagged as duplicate.

---

## AI Mode — Intelligence Module Integration

### Classification Step

```typescript
{
  provider: 'nvidia',        // from LEDGER_AI_PROVIDER
  task: 'classification',
  input: { text: userMessage },
  options: { categories: ['add', 'balance', 'summary', 'ledger', 'delete'] }
}
```

Returns: `{ label: 'add' | 'balance' | 'summary' | 'ledger' | 'delete' }`

### Extraction Step (only for `add`)

```typescript
{
  provider: 'nvidia',
  task: 'extraction',
  input: { text: userMessage },
  options: { fields: ['type', 'amount', 'party', 'category'] }
}
```

Returns: `{ fields: { type, amount, party, category } }`

After extraction, the AI payload is converted back to the same structured format that `ledger-entry/flow.ts` expects — ensuring the same downstream parsing and validation logic applies regardless of mode.

---

## Configuration

### Environment Variables (`apps/ledger/.env`)

| Variable | Purpose | Current Value |
|----------|---------|---------------|
| `PORT` | Express server port | `3000` |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verification token | Set |
| `LEDGER_SHEET_ID` | Google Sheets document ID | Set |
| `LEDGER_OWNER_PHONE` | Owner phone (E.164) | Set |
| `COMM_PROVIDER` | Communication provider | `meta` |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Business Account phone ID | Set |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API bearer token | Set |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP service account JSON | **Empty — must be set** |
| `LEDGER_MODE` | Parsing mode | `ai` |
| `LEDGER_AI_PROVIDER` | AI provider | `nvidia` |
| `NVIDIA_API_KEY` | NVIDIA NIM API key | Set |
| `NVIDIA_BASE_URL` | NVIDIA NIM endpoint | `https://integrate.api.nvidia.com/v1` |
| `NVIDIA_MODEL` | LLM model name | `meta/llama-3.1-8b-instruct` |
| `LOG_LEVEL` | Logging verbosity | `info` |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webhook` | Meta webhook verification handshake |
| `POST` | `/webhook` | Receive incoming WhatsApp messages |
| `GET` | `/health` | Health check — `{"status":"ok","app":"ledger"}` |

No scheduled cron jobs. The ledger app is entirely event-driven.

---

## Response Message Formats

**Entry recorded:**
```
Entry recorded.
Credit: 5000
Party: rahul
Category: income
Date: 2026-03-26
```

**Duplicate warning:**
```
Duplicate entry skipped.
A credit of 5000 for rahul already exists.
```

**Balance:**
```
Balance Summary

Credits : 15000.00
Debits  : 8200.00
Balance : +6800.00
```

**Daily summary:**
```
Summary: 2026-03-26

+ 5000.00  rahul (income)
- 1200.00  groceries (food)

Credits : 5000.00
Debits  : 1200.00
Net     : +3800.00
```

**Party ledger:**
```
Ledger: rahul

+ 5000.00  2026-03-20
+ 3000.00  2026-03-22
- 1000.00  2026-03-25

Credits : 8000.00
Debits  : 1000.00
Net     : +7000.00
```

**Delete confirmation:**
```
Last entry deleted.
Type    : credit
Amount  : 5000
Party   : rahul
Date    : 2026-03-26
```

**Invalid input (structured mode):**
```
Invalid input. Try:
  add credit 5000 rahul
  add debit 1200 groceries
  balance
  summary today
  ledger rahul
  delete last
```

---

## Known Constraints and Issues

| Constraint | Detail |
|-----------|--------|
| Port conflict with mining app | Both apps default to port `3000` — only one can run at a time without changing `PORT` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` is empty | Ledger `.env` has a blank value — Sheets calls will fail until populated |
| Balance reads all rows, no user filter | `ledger-balance` and `ledger-summary` don't filter by `User` column — all users share the same balance view |
| Soft delete leaves blank rows | Deleted entries stay as empty rows in the sheet, accumulating over time |
| Duplicate check is date-agnostic | Same amount + party on a different date is still flagged as duplicate |
| No multi-owner support | `LEDGER_OWNER_PHONE` is defined in config but never used in any flow |
| AI extraction quality varies | The LLM may misclassify or misextract on ambiguous messages; no fallback retry |
| No pagination on reads | All rows are read in one call; degrades on large datasets |

---

## Potential Enhancements

| Enhancement | Value | Complexity |
|-------------|-------|-----------|
| Per-user balance isolation | Each user sees only their own totals | Low |
| Date-aware duplicate detection | Allow same entry on different days | Low |
| Hard delete with row removal | Clean up blank rows from soft deletes | Medium |
| Category breakdown in summary | Group expenses by category | Low |
| Date-range queries (`summary last week`) | Historical reporting | Medium |
| Multi-user onboarding | Self-service registration via WhatsApp | High |
| Export to PDF or CSV on demand | Shareable reports | Medium |
