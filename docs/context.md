# Execution Context

The `ExecutionContext` is the single shared data structure threaded through a flow. It carries the triggering event, pre-loaded configuration, and step-by-step outputs.

---

## Type Definition

```typescript
// modules/engine/src/types.ts
type ExecutionContext = {
  event?: any;                        // triggering event — set by caller before runFlow()
  outputs?: Record<string, unknown>;  // step outputs — keyed by step id, written by engine
  state?: Record<string, any>;        // caller-defined data — config, pre-computed values
};
```

---

## `ctx.event`

**Set by**: The flow handler before calling `runFlow()`.
**Read by**: Flow step `input()` functions.

Carries the raw triggering event. Shape depends on the flow.

**Example** (mining-reporting, `flows/mining-reporting/src/flow.ts`):
```typescript
ctx.event = {
  userId: 'whatsapp:+917017875169',  // formatted phone from apps/mining/src/server.ts
  message: 'Mine: North Mine\nLabor: 25\n...',
  messageId: 'wamid.test123',
}
```

**Example** (daily-summary, `apps/mining/src/server.ts`):
```typescript
ctx.event = {}  // cron-triggered flows have no inbound event
```

**Example** (intent-router, `flows/ledger/intent-router/flow.ts`):
```typescript
ctx.event = {
  message: 'add credit 5000 rahul',
  user: '+917017875169',
}
```

---

## `ctx.outputs`

**Set by**: The engine (`runner.ts:28-29`) after each successful step.
**Read by**: Subsequent step `input()` and `condition()` functions.

```typescript
// After step 'fetch-reports' completes:
ctx.outputs = {
  'fetch-reports': { rows: [...] }   // whatever storage-module returned in res.output
}
```

**Key points**:
- Key is the step's `id` string.
- Value is whatever `ModuleResult.output` the module returned.
- `ctx.outputs` is `undefined` until the first step writes to it (engine initializes it lazily: `context.outputs ??= {}`).
- Skipped steps and failed steps do **not** write to `ctx.outputs`.
- Read safely: `ctx.outputs?.['step-id']` — always use optional chaining.

**Type cast required**: `ctx.outputs` values are `unknown`. Cast to the expected shape from the module's output contract.

```typescript
// Reading storage read output:
const data = ctx.outputs?.['fetch-reports'] as { rows: Record<string, string>[] } | undefined;
const rows = data?.rows ?? [];
```

---

## `ctx.state`

**Set by**: The flow handler before calling `runFlow()`.
**Read by**: Flow step `input()` and `condition()` functions (read-only from within the flow).

Carries any data that needs to be available across all steps without being the output of a specific step. Typical content: config values, pre-validated data, pre-computed rows.

**Shape for cron flows** (`apps/mining/src/server.ts`):

```typescript
// daily-summary:
ctx.state = {
  config: {
    ownerPhone: string,
    sheetId: string,
  },
}

// missed-reports adds managers:
ctx.state = {
  config: {
    ownerPhone: string,
    sheetId: string,
    managers: Record<string, string[]>,  // phone → mines[]
  },
}
```

**Shape for mining-reporting** (`flows/mining-reporting/src/flow.ts`):

```typescript
ctx.state = {
  config: {
    mines: string[],        // authorized mines for this manager
    ownerPhone: string,
    sheetId: string,
  },
  parsed: {                 // ParsedReport from the WhatsApp message
    mine: string,
    labor: string,
    machineA: string,
    machineB: string,
    output: string,
    material: string,
  },
  row: string[],            // ready-to-write Sheets row: [date, mine, labor, machineA, machineB, output, material, userId]
}
```

**Shape for intent-router** (`flows/ledger/intent-router/flow.ts`):

```typescript
ctx.state = {
  config: {
    mode: 'structured' | 'ai',
    aiProvider: 'openai' | 'anthropic' | 'local' | 'nvidia',
    ownerPhone: string,
  },
  structured: RouterPayload | null,  // result of deterministic parse; non-null = AI skipped
  needsAI: boolean,                  // true when structured parse failed AND mode === 'ai'
  validInput: boolean,               // false → send-invalid step fires
}
```

**Shape for ledger sub-flows** (ledger-entry, ledger-balance, etc.):

```typescript
// ledger-entry:
ctx.state = {
  config: { sheetId: string, ownerPhone: string },
  parsed: { type, amount, party, category, date, user },
}

// ledger-balance / ledger-summary:
ctx.state = {
  config: { sheetId: string, ownerPhone: string },
  user: string,       // phone number
  today?: string,     // YYYY-MM-DD (summary only)
}

// ledger-party:
ctx.state = {
  config: { sheetId: string, ownerPhone: string },
  party: string,
}

// ledger-delete:
ctx.state = {
  config: { sheetId: string, ownerPhone: string },
  user: string,
}
```

---

## Lifecycle

```
1. Caller creates ExecutionContext:
   { event: {...}, state: { config: {...} } }

2. Caller calls runFlow(flow, ctx, modules):
   Engine shallow-copies: context = { ...initialContext }

3. Step N executes:
   - step.input(context) → reads ctx.event, ctx.outputs, ctx.state
   - module returns { ok: true, output: X }
   - engine writes: context.outputs['step-N-id'] = X

4. Step N+1 executes:
   - step.condition(context) → can read ctx.outputs['step-N-id']
   - step.input(context) → can read ctx.outputs['step-N-id']

5. runFlow() returns:
   { ok: true, context: <final context>, steps: StepResult[] }
   context.outputs now contains all successful step outputs
```

---

## What Context Is NOT

- **Not a database**: context is ephemeral, created per flow invocation, discarded after `runFlow()` returns.
- **Not shared across flows**: each `runFlow()` call gets its own context. The ledger handler calls `runFlow()` twice — once for the intent router, once for the sub-flow — each with its own context.
- **Not mutated by callers during a flow**: `step.input()` and `step.condition()` must not write to context — they are pure read functions.
- **Not typed per flow**: `ctx.state` and `ctx.outputs` values are `any` / `unknown` — callers must cast.
