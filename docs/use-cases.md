# Use Cases

---

## Mining System (`apps/mining/`)

All mining flows use the Google Sheets storage backend. Communication uses the default provider (Twilio, or Meta if `COMM_PROVIDER=meta`).

### Manager Configuration

Centralized config file: `flows/config/managers.json`.

Loaded by:
- `apps/mining/src/server.ts` at startup
- `flows/mining-reporting/src/flow.ts` at module load time

```json
{
  "whatsapp:+917017875169": {
    "mines": ["North Mine", "South Mine"],
    "ownerPhone": "+917017875169",
    "sheetId": "1McSbZiaEZjk79PaBUtxdFiKnz1aB2jUPDFJJCFsobmE"
  }
}
```

Key format: `whatsapp:+E164` — must match exactly what `apps/mining/src/server.ts` produces from `result.event.userId` (it prefixes `whatsapp:` before calling the handler).

---

### Flow 1: Mining Report Submission

**File**: `flows/mining-reporting/src/`
**Trigger**: Incoming WhatsApp text message via `POST /webhook`
**Entry point**: `flows/mining-reporting/src/handler.ts` — `handleMiningReport()`

#### Trigger path

```
POST /webhook
  → res.sendStatus(200)   (immediate ACK)
  → setImmediate(async () => {
      receive({ source:'whatsapp', provider:'meta', payload: req.body })
      → result.event: NormalizedEvent
      → userId = 'whatsapp:' + result.event.userId
      → handleMiningReport({ userId, message, messageId })
    })
```

#### Pre-flow validation (`buildInitialContext()` — `flow.ts:153`)

Synchronous. If any fails, `runFlow()` is never called. A WhatsApp error is always sent back.

| Step | Logic | Failure reason | Reply |
|---|---|---|---|
| Resolve manager | Look up `userId` in `managers.json` | `manager_not_found` | `'❌ You are not authorized to submit reports.'` |
| Parse message | Split on `\n`, parse `key: value` pairs | `invalid_format` | `'❌ Invalid report format. Please follow the template.'` |
| Validate mine | Match `parsed.mine` against `config.mines` (case + whitespace insensitive) | `unauthorized_mine` | `'❌ Mine name does not match your assigned mines.'` |
| Prepare row | Build `string[]`: `[date, mine, labor, machineA, machineB, output, material, userId]` | — | — |

#### Expected Message Format

```
Mine: North Mine
Labor: 25
Machine A Hours: 6
Machine B Hours: 4
Output (tons): 120
Material: Iron
```

Parsing is key-insensitive. Required fields: `mine`, `output (tons)`. All others default to `''`.

#### Flow Steps (`miningReportFlow`)

| Step ID | Type | Module Input | Reads from ctx |
|---|---|---|---|
| `store-report` | `storage` | `{ provider:'sheets', operation:'write', resource:sheetId, data:row, options:{range:'Sheet1'} }` | `ctx.state.config.sheetId`, `ctx.state.row` |
| `reply-manager` | `communication` | `{ to: userId, message: '✅ Report submitted...' }` | `ctx.event.userId`, `ctx.state.parsed` |
| `notify-owner` | `communication` | `{ to: ownerPhone, message: '📊 Report from Mine...' }` | `ctx.state.config.ownerPhone`, `ctx.state.parsed` |

#### Sheet Row Written (Sheet1)

| Col | Value |
|---|---|
| A | date (YYYY-MM-DD) |
| B | mine name |
| C | labor |
| D | machine A hours |
| E | machine B hours |
| F | output (tons) |
| G | material |
| H | manager phone (userId) |

---

### Flow 2: Daily Summary

**File**: `flows/daily-summary/src/flow.ts`
**Trigger**: Cron at 20:00 daily OR `POST /run/daily-summary`
**Entry point**: `apps/mining/src/server.ts` — `runDailySummary()`

#### Context

```typescript
ctx.state.config = { ownerPhone: OWNER_PHONE, sheetId: SHEET_ID }
```

#### Flow Steps (`dailySummaryFlow`)

| Step ID | Type | Action |
|---|---|---|
| `fetch-reports` | `storage` | Read all rows from Sheet1 |
| `send-summary` | `communication` | Build and send aggregated summary to owner |

#### Summary Logic

1. Filter rows where `row[0] === today` (ISO date, col A).
2. Aggregate `labor` (col C) and `output` (col F) per mine (col B).
3. If no rows today → `'No reports received today.'`

#### Row Normalization

`normalizeRows()` handles both `Record<string, string>[]` (header-row sheets) and `string[][]` (headerless sheets) by reconstructing the first row from object keys.

---

### Flow 3: Missed Reports

**File**: `flows/missed-reports/src/flow.ts`
**Trigger**: Cron at 18:00 daily OR `POST /run/missed-reports`
**Entry point**: `apps/mining/src/server.ts` — `runMissedReports()`

#### Context

```typescript
ctx.state.config = {
  ownerPhone: OWNER_PHONE,
  sheetId: SHEET_ID,
  managers: MANAGERS,  // Record<phone, mines[]> — derived from managers.json
}
```

#### Flow Steps (`missedReportsFlow`)

| Step ID | Type | Condition | Action |
|---|---|---|---|
| `fetch-reports` | `storage` | none | Read all rows from Sheet1 |
| `send-missing-report` | `communication` | `getMissingMines(ctx).length > 0` | Send list of unreported mines to owner |

#### Missing Mine Logic

1. Build `allMines` from all managers' mine lists.
2. Build `submittedMines` from today's rows: `row[0] === today && row[1]`.
3. Send list of mines in `allMines` that are not in `submittedMines`.

---

### Reliability for Scheduled Flows

Both `runDailySummary()` and `runMissedReports()` include:
- **Idempotency**: In-memory `Map` keyed `'flowName:YYYY-MM-DD'` — prevents re-run on same calendar day (lost on process restart).
- **Concurrency lock**: Boolean flag prevents overlapping runs.
- **Throttle**: Minimum 2-second gap between flow starts.
- **Retry**: 3 attempts with 2-second delay on failure.

See `docs/engine.md` for implementation details.

---

## Ledger System (`apps/ledger/`)

**Entry point**: `apps/ledger/src/handler.ts` — `handleLedgerMessage()`
**Sheet**: Google Sheets, tab named `Ledger`
**Columns**: `Date | Type | Amount | Party | Category | User`
**Trigger**: Incoming WhatsApp text message via `POST /webhook`

### Modes

The ledger app supports two modes, configured via `LEDGER_MODE` env var:

| Mode | Value | How it works |
|---|---|---|
| **Structured** | `'structured'` (default) | Exact text matching — deterministic, no AI |
| **AI** | `'ai'` | AI classification + extraction when structured parsing fails |

### Full Flow Architecture

```
Incoming WhatsApp message
  → apps/ledger/src/server.ts
  → ingestion-module (normalize)
  → handleLedgerMessage()
      → buildInitialContext()  [structured parse attempt]
      → runFlow(intentRouterFlow, ...)
          → classify-intent   [AI only, if needed]
          → extract-transaction [AI only, if command=add]
          → send-invalid      [if no valid command]
      → resolveRouting()  [determine next flow]
      → dispatch to correct sub-flow
```

### Intent Router (`flows/ledger/intent-router/flow.ts`)

**Structured parsing** (always attempted first, regardless of mode):

| Input | Command | Parsed as |
|---|---|---|
| `"balance"` | `balance` | — |
| `"summary ..."` | `summary` | — |
| `"delete last"` | `delete` | — |
| `"ledger <party>"` | `ledger` | party name |
| `"add <credit\|debit> <amount> <party> [category]"` | `add` | all fields |

If structured parsing succeeds, AI steps are skipped even in `ai` mode.

**AI mode** (when structured parsing fails and `LEDGER_MODE=ai`):

| Step | ID | Condition | Action |
|---|---|---|---|
| Classify | `classify-intent` | `needsAI === true` | AI classification → one of: `add`, `balance`, `summary`, `ledger`, `delete` |
| Extract | `extract-transaction` | `needsAI && classify.label === 'add'` | AI extraction → `{ type, amount, party, category }` |
| Invalid | `send-invalid` | `!validInput` | Send help message to user |

**`resolveRouting()`** maps the result to the next flow:

| Command | Next Flow |
|---|---|
| `add` | `ledger-entry` |
| `balance` | `ledger-balance` |
| `summary` | `ledger-summary` |
| `ledger` | `ledger-party` |
| `delete` | `ledger-delete` |

**AI Provider**: Configured via `LEDGER_AI_PROVIDER` env var. Valid values: `openai`, `anthropic`, `local`, `nvidia`.

---

### Sub-Flow 1: ledger-entry

**File**: `flows/ledger/ledger-entry/flow.ts`

**Input format**: `add <credit|debit> <amount> <party> [category]`

Amount parsing: supports `k` suffix (e.g. `2.5k` → 2500). Negative amounts and zero rejected.

| Step ID | Type | Condition | Action |
|---|---|---|---|
| `check-duplicate` | `storage` | none | Query Ledger sheet for same Type+Amount+Party+User |
| `write-to-sheet` | `storage` | `check-duplicate.rows.length === 0` | Append `[date, type, amount, party, category, user]` to Ledger |
| `send-success` | `communication` | `check-duplicate.rows.length === 0` | Confirm entry to sender |
| `send-duplicate-warning` | `communication` | `check-duplicate.rows.length > 0` | Warn about duplicate |

---

### Sub-Flow 2: ledger-balance

**File**: `flows/ledger/ledger-balance/flow.ts`

| Step ID | Type | Action |
|---|---|---|
| `read-sheet` | `storage` | Read all rows from Ledger tab |
| `send-balance` | `communication` | Sum all credits/debits, reply with net balance |

Reply format:
```
Balance Summary

Credits : 15000.00
Debits  : 8500.00
Balance : +6500.00
```

---

### Sub-Flow 3: ledger-summary

**File**: `flows/ledger/ledger-summary/flow.ts`

| Step ID | Type | Action |
|---|---|---|
| `read-sheet` | `storage` | Read all rows from Ledger tab |
| `send-summary` | `communication` | Filter today's rows, aggregate per type, reply |

---

### Sub-Flow 4: ledger-party

**File**: `flows/ledger/ledger-party/flow.ts`

**Trigger**: `"ledger <party>"` or AI-classified `ledger` command.

| Step ID | Type | Action |
|---|---|---|
| `read-sheet` | `storage` | Read all rows from Ledger tab |
| `send-party-ledger` | `communication` | Filter rows by party name (case-insensitive), reply with ledger |

Reply format:
```
Ledger: rahul

+ 5000.00  2026-03-20
- 2000.00  2026-03-21

Credits : 5000.00
Debits  : 2000.00
Net     : +3000.00
```

---

### Sub-Flow 5: ledger-delete

**File**: `flows/ledger/ledger-delete/flow.ts`

**Trigger**: `"delete last"` (structured mode) or AI-classified `delete` command.

Performs a soft delete: overwrites the last row belonging to the user with blank values.

| Step ID | Type | Condition | Action |
|---|---|---|---|
| `read-sheet` | `storage` | none | Read all rows from Ledger tab |
| `overwrite-last-row` | `storage` | last user row exists | Update row with blank `['','','','','','']` |
| `send-confirmation` | `communication` | `overwrite-last-row` output is defined | Confirm deletion with original row data |
| `send-no-entries` | `communication` | `overwrite-last-row` output is `undefined` | Notify no entries to delete |

---

### Ledger Config

Loaded from env vars in `apps/ledger/src/handler.ts`:

| Env var | Required | Description |
|---|---|---|
| `LEDGER_SHEET_ID` | yes | Google Sheets document ID |
| `LEDGER_OWNER_PHONE` | yes | Owner's phone number |
| `LEDGER_MODE` | no | `'structured'` (default) or `'ai'` |
| `LEDGER_AI_PROVIDER` | no | `'anthropic'` (default), `'openai'`, `'local'`, `'nvidia'` |
