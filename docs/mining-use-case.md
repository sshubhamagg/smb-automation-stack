# Mining Operations Reporting — Use Case Document

## Overview

The Mining App is a WhatsApp-based automated reporting system for managing daily operations across multiple mine sites. Mine managers submit structured daily reports via WhatsApp messages. The system parses, validates, persists, and routes those reports — and automatically escalates missing reports and delivers end-of-day summaries to the owner.

---

## Business Context

### Problem Statement

Mine owners managing multiple sites face the challenge of collecting daily operational data from field managers who may have limited connectivity or tech familiarity. Manual collection via calls or spreadsheets is error-prone and creates delays in visibility.

### Solution

A WhatsApp-native reporting system that:
- Accepts structured text messages from authorized managers
- Stores data directly in Google Sheets
- Proactively alerts the owner when reports are missing
- Delivers a consolidated daily summary automatically

### Stakeholders

| Role | Responsibility | System Interaction |
|------|---------------|-------------------|
| Mine Manager | Submits daily operational reports | Sends WhatsApp message to system number |
| Mine Owner | Monitors output across all mines | Receives WhatsApp summaries and alerts |
| System (Bot) | Validates, stores, routes | Webhook-triggered + cron-scheduled |

---

## Functional Requirements

### FR-1: Report Submission

- A manager sends a WhatsApp message in a defined key-value format
- System verifies the sender is an authorized manager
- System validates the report format and mine ownership
- System stores the report in Google Sheets
- System confirms receipt to the manager
- System notifies the owner with a summary of the report

**Required Message Format:**
```
Mine: North Mine
Labor: 25
Machine A Hours: 6
Machine B Hours: 4
Output (tons): 120
Material: Iron
```

### FR-2: Authorization

- Only pre-configured manager phone numbers may submit reports
- Each manager is authorized only for specific mines
- Unauthorized senders and unauthorized mine names are rejected with an error message

### FR-3: Missed Report Alerts

- At 6:00 PM daily, the system checks which mines have not submitted a report
- If any mines are missing, the owner receives a WhatsApp alert listing them

### FR-4: Daily Summary

- At 8:00 PM daily, the system aggregates all reports for the day
- A consolidated summary (labor + output per mine, total output) is sent to the owner via WhatsApp

### FR-5: Error Feedback

All validation failures return a descriptive error message to the manager via WhatsApp before terminating.

---

## User Flows

### Report Submission Flow

```
Manager sends WhatsApp message
        │
        ▼
[Webhook] POST /webhook
        │
        ▼
Ingestion: parse Meta payload → NormalizedEvent
        │
        ▼
Pre-flow Validation (synchronous)
  ├─ Check: sender in managers.json?       → ❌ "not authorized"
  ├─ Check: required fields present?        → ❌ "invalid format"
  └─ Check: mine in manager's mine list?    → ❌ "unauthorized mine"
        │
        ▼
Flow Execution (sequential steps)
  ├─ Step 1: Write row to Google Sheets
  ├─ Step 2: Reply to manager: "✅ Report submitted"
  └─ Step 3: Notify owner: "📊 Report from {mine}"
```

### Missed Report Alert Flow (6 PM Cron)

```
cron: 0 18 * * *
        │
        ▼
Read all rows from Google Sheets
        │
        ▼
Compute: allMines − reportedTodayMines
        │
        ▼
If missing mines exist → Send alert to owner
        │
        └─ "⚠️ Missing Reports\nNorth Mine\nSouth Mine"
```

### Daily Summary Flow (8 PM Cron)

```
cron: 0 20 * * *
        │
        ▼
Read all rows from Google Sheets
        │
        ▼
Filter: rows where date == today
        │
        ▼
Aggregate per mine: sum(labor), sum(output)
        │
        ▼
Send summary to owner via WhatsApp
```

---

## Technical Architecture

### System Components

```
┌──────────────────────────────────────────────────────────┐
│                   Mining App (Express)                    │
│                   apps/mining/src/server.ts               │
│                                                          │
│  ┌──────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ POST /webhook│  │ POST /run/daily │  │Cron 6PM/8PM │ │
│  └──────┬───────┘  └────────┬────────┘  └──────┬──────┘ │
│         │                   │                   │        │
└─────────┼───────────────────┼───────────────────┼────────┘
          │                   │                   │
          ▼                   ▼                   ▼
  ┌───────────────┐   ┌──────────────┐   ┌──────────────┐
  │ ingestion-    │   │ daily-summary│   │missed-reports│
  │ module        │   │ flow         │   │ flow         │
  └───────┬───────┘   └──────┬───────┘   └──────┬───────┘
          │                  │                   │
          ▼                  │                   │
  ┌───────────────┐          ▼                   ▼
  │ mining-report │   ┌──────────────────────────────────┐
  │ flow          │   │          engine-module            │
  └───────┬───────┘   │        (runFlow executor)         │
          │           └──────────────────────────────────┘
          │                    │               │
          ▼                    ▼               ▼
  ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
  │ storage-     │   │communication│   │ storage-     │
  │ module       │   │ -module     │   │ module       │
  │ (Sheets write│   │ (WhatsApp)  │   │ (Sheets read)│
  └──────────────┘   └─────────────┘   └──────────────┘
```

### Module Usage

| Module | Used For | Operation |
|--------|----------|-----------|
| `ingestion-module` | Parse Meta webhook payload | `receive({ source: 'whatsapp', provider: 'meta', payload })` |
| `storage-module` | Read/write Google Sheets | `execute({ provider: 'sheets', operation: 'read'/'write', resource: sheetId })` |
| `communication-module` | Send WhatsApp messages | `execute({ to, message })` |
| `engine-module` | Orchestrate flow steps | `runFlow(flow, context, modules)` |
| `intelligence-module` | Not used | — |

### Flow Definitions

#### 1. `mining-report` flow (`flows/mining-reporting/src/flow.ts`)

| Step ID | Type | Action |
|---------|------|--------|
| `store-report` | storage | Write parsed row to Google Sheets |
| `reply-manager` | communication | Confirm receipt to manager |
| `notify-owner` | communication | Send report summary to owner |

**Pre-flow validation** (`buildInitialContext`) runs before engine invocation:
1. Resolve manager config from `managers.json`
2. Parse message key-value pairs
3. Validate mine name against authorized list

#### 2. `daily-summary` flow (`flows/daily-summary/src/flow.ts`)

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `fetch-reports` | storage | always | Read all rows from Sheets |
| `send-summary` | communication | always | Aggregate by mine, send to owner |

#### 3. `missed-reports` flow (`flows/missed-reports/src/flow.ts`)

| Step ID | Type | Condition | Action |
|---------|------|-----------|--------|
| `fetch-reports` | storage | always | Read all rows from Sheets |
| `send-missing-report` | communication | only if missing mines > 0 | Alert owner |

---

## Data Model

### Manager Configuration (`flows/config/managers.json`)

```json
{
  "whatsapp:+917017875169": {
    "mines": ["North Mine", "South Mine"],
    "ownerPhone": "+917017875169",
    "sheetId": "1McSbZiaEZjk79PaBUtxdFiKnz1aB2jUPDFJJCFsobmE"
  }
}
```

### Google Sheets Row Schema

| Column | Index | Type | Description |
|--------|-------|------|-------------|
| Date | 0 | ISO 8601 string | Report date (YYYY-MM-DD) |
| Mine | 1 | string | Mine name |
| Labor | 2 | string | Number of laborers |
| Machine A Hours | 3 | string | Machine A operational hours |
| Machine B Hours | 4 | string | Machine B operational hours |
| Output (tons) | 5 | string | Production output in tons |
| Material | 6 | string | Material type extracted |
| Manager Phone | 7 | string | Reporting manager's WhatsApp number |

### Execution Context Shape

```typescript
{
  event: {
    userId: string;       // Manager WhatsApp phone (E.164)
    message?: string;     // Raw message text
    metadata?: { messageId?: string; receivedAt?: string }
  },
  outputs: {
    [stepId: string]: unknown  // Each step's result stored here
  },
  state: {
    config: {
      mines: string[];
      ownerPhone: string;
      sheetId: string;
    },
    parsed: {
      mine: string; labor: string; machineA: string;
      machineB: string; output: string; material: string;
    },
    row: string[]  // Ordered columns ready for Sheets write
  }
}
```

---

## Configuration

### Environment Variables (`apps/mining/.env`)

| Variable | Purpose |
|----------|---------|
| `PORT` | Express server port (default: 3000) |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook handshake token |
| `OWNER_PHONE` | Owner's WhatsApp number (E.164) |
| `SHEET_ID` | Google Sheets document ID |
| `COMM_PROVIDER` | Communication provider (`meta`) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Business Account phone ID |
| `WHATSAPP_ACCESS_TOKEN` | Meta Graph API bearer token |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | GCP service account JSON (for Sheets access) |
| `LOG_LEVEL` | Logging verbosity (`info`, `debug`, `error`) |

---

## Safety and Reliability Mechanisms

| Mechanism | Implementation | Purpose |
|-----------|---------------|---------|
| Authorization | `managers.json` phone lookup | Prevent unauthorized submissions |
| Message validation | Required fields check | Reject malformed reports |
| Mine ownership | Case-insensitive config match | Prevent cross-mine reporting |
| Duplicate run prevention | Per-day execution registry | Cron flows run at most once per day |
| Throttling | 2s minimum interval between flow runs | Respect API rate limits |
| Retry logic | 3 attempts, 2s exponential backoff | Handle transient failures |
| Error feedback | WhatsApp error messages on all failures | Manager always receives a response |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/webhook` | Meta webhook verification handshake |
| `POST` | `/webhook` | Receive incoming WhatsApp messages |
| `POST` | `/run/daily-summary` | Manually trigger daily summary flow |
| `POST` | `/run/missed-reports` | Manually trigger missed-reports flow |
| `GET` | `/health` | Health check |

---

## Scheduled Jobs

| Cron | Time | Flow Triggered |
|------|------|---------------|
| `0 18 * * *` | 6:00 PM daily | `missed-reports` — alert owner of missing mines |
| `0 20 * * *` | 8:00 PM daily | `daily-summary` — send consolidated output report |

---

## Known Constraints and Limitations

- **Single owner model** — one owner phone per manager config entry; no multi-owner broadcasts
- **No Sheets pagination** — all rows are read in a single call; suitable for up to ~10k rows
- **Manual message parsing** — key-value extraction is regex/split-based, not AI-assisted; sensitive to typos in field names
- **No report amendment** — duplicate reports for the same mine/day are appended, not replaced
- **Intelligence module unused** — imported but not integrated; AI-assisted parsing is a potential future enhancement
- **No authentication beyond phone** — sender identity relies solely on WhatsApp phone number matching config

---

## Potential Enhancements

| Enhancement | Value | Complexity |
|-------------|-------|-----------|
| AI-assisted message parsing | Handle freeform/typo-tolerant messages | Medium |
| Report deduplication | Prevent double-submission for same mine/day | Low |
| Multi-owner notifications | Alert multiple stakeholders per mine | Low |
| Sheets pagination | Support larger datasets | Medium |
| Manager onboarding flow | Self-service registration via WhatsApp | High |
| Dashboard integration | Sheets → BI tool pipeline | High |
