# Flows

A flow is a plain TypeScript object that declares a sequence of steps. The engine executes it. The flow owns all business logic. Modules own none.

---

## What a Flow Is

```typescript
// modules/engine/src/types.ts
type Flow = {
  id: string;
  steps: FlowStep[];
};
```

A flow is **not a class**, **not registered globally**, and has **no lifecycle hooks**. It is a data structure passed directly to `runFlow()`.

---

## Step Definition

```typescript
// modules/engine/src/types.ts
type FlowStep = {
  id: string;                                            // unique within the flow
  type: 'intelligence' | 'storage' | 'communication';   // which module to call
  input?: (context: ExecutionContext) => unknown;        // builds module input; defaults to {}
  condition?: (context: ExecutionContext) => boolean;    // false = skip step (not fail)
};
```

**Required fields**: `id`, `type`.

**`input(ctx)`**: Pure function. Receives the current context (including all prior step outputs) and returns the input object for the module. Must not perform I/O or have side effects.

**`condition(ctx)`**:
- Returns `false` → step is marked `'skipped'` and skipped. Flow continues to next step.
- Returns `true` → step executes normally.
- Throws → step is marked `'failed'`. Flow stops.
- Absent → always runs.

---

## Data Passing Between Steps

Step outputs are written to `ctx.outputs[step.id]` by the engine after each successful step. All subsequent steps can read these via their `input(ctx)` or `condition(ctx)` functions.

```typescript
// Step 1 — write data
{
  id: 'fetch-reports',
  type: 'storage',
  input: () => ({ provider: 'sheets', operation: 'read', resource: 'SHEET_ID', options: { range: 'Sheet1' } }),
}

// Step 2 — read step 1's output
{
  id: 'send-summary',
  type: 'communication',
  condition: (ctx) => {
    const data = ctx.outputs?.['fetch-reports'] as { rows: unknown[] } | undefined;
    return (data?.rows?.length ?? 0) > 0;
  },
  input: (ctx) => {
    const data = ctx.outputs?.['fetch-reports'] as { rows: unknown[] };
    return { to: ctx.state?.config?.ownerPhone, message: `${data.rows.length} rows found` };
  },
}
```

**Critical**: `ctx.outputs?.['step-id']` is `undefined` if the step hasn't run yet, was skipped, or failed.

---

## Pre-flow Context Building

The engine has no `'transform'` or `'validation'` step type. Synchronous pre-processing (parsing, validation, data shaping) is done **before** calling `runFlow()` in a `buildInitialContext()` function.

Pattern (from `flows/mining-reporting/src/flow.ts`):

```typescript
export function buildInitialContext(event: MiningReportEvent): BuildContextResult {
  // step 1: resolve manager from registry
  const config = resolveManager(event.userId);
  if (!config) return { ok: false, reason: 'manager_not_found' };

  // step 2: parse message text
  const parsed = parseMessage(event.message ?? '');
  if (!parsed) return { ok: false, reason: 'invalid_format' };

  // step 3: validate mine ownership
  const matchedMine = config.mines.find(m => normalize(m) === normalize(parsed.mine));
  if (!matchedMine) return { ok: false, reason: 'unauthorized_mine' };

  // step 4: prepare row for Sheets
  const row = prepareRow({ ...parsed, mine: matchedMine }, config, event.userId);

  return {
    ok: true,
    context: {
      event,
      state: { config, parsed: { ...parsed, mine: matchedMine }, row },
    },
  };
}
```

This returns a fully populated `ExecutionContext`. If validation fails, `runFlow()` is never called.

---

## Flow Execution Modes

### Webhook-triggered (event-driven)

```typescript
// apps/ledger/src/server.ts — POST /webhook handler
const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });
if (!result.ok) return;

await handleLedgerMessage({ phone_number: result.event.userId, text_body: result.event.message, message_type: 'text' });
// handleLedgerMessage calls buildInitialContext() then runFlow() (possibly multiple times)
```

### HTTP-triggered (manual)

```typescript
// apps/mining/src/server.ts — POST /run/daily-summary
app.post('/run/daily-summary', async (_req, res) => {
  await runDailySummary();
  res.json({ ok: true });
});
```

### Cron-triggered (scheduled)

```typescript
// apps/mining/src/server.ts
cron.schedule('0 20 * * *', async () => {
  await runDailySummary();
});
```

---

## Multi-Flow Dispatch (Ledger Pattern)

The ledger app runs multiple flows in sequence for a single message:

```typescript
// apps/ledger/src/handler.ts
// Step 1: run intent-router flow
const routerResult = await runFlow(intentRouterFlow, routerCtx, modules);

// Step 2: resolve which sub-flow to run
const routing = resolveRouting(routerResult.context);

// Step 3: run the target sub-flow with its own context
const result = await runFlow(ledgerEntryFlow, entryCtx, modules);
```

Each `runFlow()` call is independent — different `Flow` objects, different contexts.

---

## Minimal Valid Flow

```typescript
import type { Flow, ExecutionContext } from 'engine-module';

const myFlow: Flow = {
  id: 'my-flow',
  steps: [
    {
      id: 'read-data',
      type: 'storage',
      input: (_ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: 'SHEET_DOC_ID',
        options: { range: 'Sheet1' },
      }),
    },
    {
      id: 'notify',
      type: 'communication',
      condition: (ctx) => {
        const data = ctx.outputs?.['read-data'] as { rows: unknown[] } | undefined;
        return (data?.rows?.length ?? 0) > 0;
      },
      input: (ctx: ExecutionContext) => {
        const data = ctx.outputs?.['read-data'] as { rows: unknown[] };
        return {
          to: ctx.state?.ownerPhone as string,
          message: `${data.rows.length} rows found`,
        };
      },
    },
  ],
};

// Caller:
const ctx: ExecutionContext = { state: { ownerPhone: '+911234567890' } };
const result = await runFlow(myFlow, ctx, modules);
```

---

## File Placement

```
flows/
├── config/
│   └── managers.json              # shared manager configuration
├── ledger/
│   ├── intent-router/flow.ts      # buildInitialContext() + intentRouterFlow + resolveRouting()
│   ├── ledger-entry/flow.ts
│   ├── ledger-balance/flow.ts
│   ├── ledger-summary/flow.ts
│   ├── ledger-party/flow.ts
│   ├── ledger-delete/flow.ts
│   ├── package.json
│   └── tsconfig.json
├── mining-reporting/
│   └── src/
│       ├── flow.ts                # buildInitialContext() + miningReportFlow
│       └── handler.ts             # handleMiningReport() — entry point
├── daily-summary/
│   └── src/flow.ts                # dailySummaryFlow
└── missed-reports/
    └── src/flow.ts                # missedReportsFlow
```

Each flow package declares `engine-module` as a dependency. Flows do **not** declare module dependencies (`storage-module`, etc.) — those are wired by the apps.
