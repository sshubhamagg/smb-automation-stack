# Architecture

## What the System Does

A modular automation platform for operations management. It receives structured messages via WhatsApp, stores reports in Google Sheets or Postgres, notifies stakeholders, and runs scheduled analysis jobs. All external I/O is abstracted behind interchangeable provider adapters.

---

## Layer Diagram

```
┌─────────────────────────────────────────────────────────┐
│                        APPS                             │
│   apps/ledger/src/server.ts   apps/mining/src/server.ts │
│   Express · webhook · flows   Express · webhook · cron  │
└───────────────────┬─────────────────────────────────────┘
                    │ runFlow(flow, ctx, modules)
┌───────────────────▼─────────────────────────────────────┐
│                      ENGINE                             │
│            modules/engine/src/runner.ts                 │
│  Sequential step loop · condition eval · fail-fast      │
└───────────────────┬─────────────────────────────────────┘
                    │ modules[step.type](input)
        ┌───────────┼────────────┬─────────────────┐
        ▼           ▼            ▼                 ▼
  ┌──────────┐ ┌─────────┐ ┌──────────────┐ ┌──────────┐
  │ingestion │ │ storage │ │communication │ │intellig. │
  │ -module  │ │ -module │ │   -module    │ │  -module │
  └────┬─────┘ └────┬────┘ └──────┬───────┘ └────┬─────┘
       │            │             │               │
  ┌────▼────┐  ┌────▼────┐  ┌────▼────┐    ┌────▼────┐
  │Adapters │  │Adapters │  │Adapters │    │Adapters │
  │  meta   │  │ sheets  │  │  meta   │    │ openai  │
  │         │  │postgres │  │ twilio  │    │anthropic│
  │         │  │         │  │telegram │    │  local  │
  └─────────┘  └─────────┘  └─────────┘    │ nvidia  │
                                            └─────────┘
```

---

## Apps

There are two independent apps. Each is a standalone Express server. Neither is aware of the other.

### `apps/ledger/` — Financial Ledger App

**Entry**: `apps/ledger/src/server.ts`

Responsibilities:
- Receive incoming WhatsApp messages via `POST /webhook`.
- Pass normalized event to `handleLedgerMessage()` (`apps/ledger/src/handler.ts`).
- Wire module executors into the `Modules` object passed to `runFlow()`.
- Load config from env vars (`LEDGER_SHEET_ID`, `LEDGER_OWNER_PHONE`, `LEDGER_MODE`, `LEDGER_AI_PROVIDER`).

No scheduled jobs. No cron. Purely event-driven.

### `apps/mining/` — Mining Operations App

**Entry**: `apps/mining/src/server.ts`

Responsibilities:
- Receive incoming WhatsApp messages via `POST /webhook`.
- Pass normalized event to `handleMiningReport()` (`flows/mining-reporting/src/handler.ts`).
- Schedule two cron jobs: `missed-reports` at 18:00, `daily-summary` at 20:00.
- Expose manual trigger endpoints: `POST /run/daily-summary`, `POST /run/missed-reports`.
- Wire module executors into the `Modules` object.
- Apply reliability mechanisms: throttle, retry, concurrency locks, in-memory idempotency registry.
- Load `flows/config/managers.json` once at startup.

---

## Engine — `modules/engine/src/`

Pure execution engine. Responsibilities:
- Iterate flow steps sequentially.
- Evaluate per-step conditions.
- Route each step to its registered module executor.
- Propagate outputs into `ctx.outputs`.
- Return a typed `ExecutionResult` — never throws.

The engine has **zero imports of concrete modules**. It receives a `Modules` object at call time and has no knowledge of what any module does.

**Only dependency**: `shared-types` (`modules/shared/src/types.ts`).

---

## Module Layer — `modules/{name}/src/index.ts`

Each module exposes a single public function. Responsibilities:
- Register adapters at module initialization.
- Dispatch `input.provider` to the correct adapter via the registry.
- Catch all exceptions and return `ModuleResult<T>` — never throws.

Modules never import each other.

**Exception**: `modules/ingestion/src/adapters/meta.ts` imports `modules/whatsapp/src/validator.ts` and `modules/whatsapp/src/normalizer.ts` via relative paths — a direct source dependency, not a module-to-module call.

---

## Adapter Layer — `modules/{name}/src/adapters/`

Concrete provider implementations. Responsibilities:
- Implement the module's adapter interface.
- Make external API calls.
- Transform provider-specific errors into module-standard results.
- Throw on failure (the module layer catches these and wraps them).

---

## Flows — `flows/{name}/src/`

Business-specific orchestrations. Responsibilities:
- Define a `Flow` object (array of steps with `input()` and `condition()` functions).
- Pre-compute context data before calling `runFlow()` when synchronous transforms are needed.
- Own all business logic — modules own none.

Flows import only from `engine-module`. They do not import concrete modules.

---

## Design Principles (Verified from Code)

| Principle | Enforced Where |
|---|---|
| **Never throw at module boundary** | Comment at top of every module `index.ts`; try/catch wraps all adapter calls |
| **Engine has no concrete module imports** | `modules/engine/package.json` — only dep is `shared-types` |
| **Sequential step execution** | `runner.ts:12` — `for (const step of flow.steps)` |
| **Fail-fast on first failure** | `runner.ts:23-25` — immediate return on `status: 'failed'` |
| **Adapter selection is data, not code** | `modules[step.type](input)` — provider name travels in `input.provider` |
| **Canonical shared type** | `ModuleResult<T>` in `modules/shared/src/types.ts` used by all modules |
| **Modules never import each other** | No cross-module imports anywhere in `modules/` |
| **Context is immutable to callers** | `runner.ts:9` — `const context = { ...initialContext }` (shallow copy) |
