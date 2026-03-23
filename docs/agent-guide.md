# Agent Guide

This document is the authoritative reference for AI agents generating automation flows for this platform. Read it completely before generating any flow code.

---

## System Model

An agent's job is to:
1. Define a `Flow` object (a plain TypeScript array of steps).
2. Optionally define a `buildInitialContext()` function for synchronous pre-processing.
3. Register a trigger in the app (`apps/ledger/` or `apps/mining/`).

An agent must NOT:
- Call external APIs directly.
- Import concrete modules (`storage-module`, `communication-module`, etc.) into flow files.
- Add business logic inside any module.
- Modify any file in `modules/`.

---

## What an Agent CAN Do

| Action | How |
|---|---|
| Read from Google Sheets | Step `type: 'storage'`, `provider: 'sheets'`, `operation: 'read'` |
| Write to Google Sheets | Step `type: 'storage'`, `provider: 'sheets'`, `operation: 'write'` |
| Query/filter Google Sheets | Step `type: 'storage'`, `provider: 'sheets'`, `operation: 'query'` |
| Update a Sheets row | Step `type: 'storage'`, `provider: 'sheets'`, `operation: 'update'` |
| Write to Postgres | Step `type: 'storage'`, `provider: 'postgres'`, `operation: 'write'` |
| Read from Postgres | Step `type: 'storage'`, `provider: 'postgres'`, `operation: 'read'` |
| Send WhatsApp (Meta) | Step `type: 'communication'`, `provider: 'meta'` |
| Send WhatsApp (Twilio) | Step `type: 'communication'`, `provider: 'twilio'` |
| Send Telegram message | Step `type: 'communication'`, `provider: 'telegram'` |
| Classify text with AI | Step `type: 'intelligence'`, `provider: 'openai'\|'anthropic'\|'local'\|'nvidia'`, `task: 'classification'` |
| Extract fields from text | Step `type: 'intelligence'`, `provider: 'openai'\|'anthropic'\|'local'\|'nvidia'`, `task: 'extraction'` |
| Answer a question about text | Step `type: 'intelligence'`, `provider: 'openai'\|'anthropic'\|'local'\|'nvidia'`, `task: 'qa'` |
| Reason over text | Step `type: 'intelligence'`, `provider: 'openai'\|'anthropic'\|'local'\|'nvidia'`, `task: 'reasoning'` |
| Skip a step conditionally | `condition: (ctx) => boolean` on a step |
| Read prior step output | `ctx.outputs?.['step-id']` inside `input()` or `condition()` |
| Read pre-loaded config | `ctx.state?.config` inside `input()` or `condition()` |
| Pre-process data before flow | Define `buildInitialContext()` — synchronous, no I/O |

---

## What an Agent MUST NOT Do

| Forbidden Action | Why |
|---|---|
| `import { execute } from 'storage-module'` inside a flow file | Flows only import from `engine-module`. Module wiring is the app's job. |
| Call `fetch()` or any HTTP client inside `step.input()` | `input()` is a pure data-builder — no I/O. I/O happens via module executors. |
| `import axios` or any external library in a flow file | Flow files have no external dependencies beyond `engine-module`. |
| Throw inside `step.input()` | Throwing marks the step as `failed` and stops the flow. Return safe values or let `condition()` skip the step instead. |
| Throw inside `step.condition()` | Same — marks step as `failed`. |
| Modify any file in `modules/` | Modules are read-only to flows. |
| Create a step with `type: 'ai'` | Does not exist. The correct type is `'intelligence'`. |
| Use `ctx.ai`, `ctx.storage`, `ctx.communication` | These namespaces do not exist. The correct field is `ctx.outputs['step-id']`. |
| Use `ctx.storage?.['step-id']` | Same — wrong. Use `ctx.outputs?.['step-id']`. |
| Assume `ctx.outputs` is defined at step 1 | It is `undefined` until the engine writes the first output. Use optional chaining: `ctx.outputs?.['id']`. |
| Assume a skipped step wrote output | Skipped steps do not write to `ctx.outputs`. Always check for `undefined`. |
| Use `result.data` on storage output | The correct field is `result.output`. `result.data` does not exist. |
| Hard-code phone numbers or sheet IDs in flow steps | These belong in `ctx.state.config`, loaded from env vars or managers.json by the app. |

---

## Valid Step Format

```typescript
{
  id: string,                              // REQUIRED — unique within the flow
  type: 'intelligence' | 'storage' | 'communication',  // REQUIRED
  input?: (ctx: ExecutionContext) => unknown,    // optional — pure function, no I/O
  condition?: (ctx: ExecutionContext) => boolean,  // optional — false = skip
}
```

---

## Module Input Contracts

### storage — sheets

```typescript
// read
{ provider: 'sheets', operation: 'read', resource: '<sheetId>', options: { range: 'Sheet1' } }

// write
{ provider: 'sheets', operation: 'write', resource: '<sheetId>', data: string[], options: { range: 'Sheet1' } }

// update
{ provider: 'sheets', operation: 'update', resource: '<sheetId>', data: string[], options: { range: 'Sheet1', rowIndex: number } }
// rowIndex is 1-based, excludes header row

// query (filter rows in-memory)
{ provider: 'sheets', operation: 'query', resource: '<sheetId>', query: { colName: 'value' }, options: { range: 'Sheet1' } }
```

### storage — postgres

```typescript
// write (INSERT)
{ provider: 'postgres', operation: 'write', resource: '<tableName>', data: { col1: val1, col2: val2 } }

// read (SELECT)
{ provider: 'postgres', operation: 'read', resource: '<tableName>', query: { col1: val1 } }  // query optional

// update (UPDATE ... WHERE)
{ provider: 'postgres', operation: 'update', resource: '<tableName>', data: { col: newVal }, query: { id: 1 } }
// query is REQUIRED for update
```

Note: `operation: 'query'` is NOT supported for postgres. Use `operation: 'read'` with a `query` field for filtered selects.

### communication

```typescript
{ to: '<phone-or-chat-id>', message: '<text>', provider?: '<meta|twilio|telegram>' }
// provider optional — defaults to COMM_PROVIDER env var, then 'twilio'
// for meta/twilio: `to` is E.164 phone, e.g. '+917017875169' or 'whatsapp:+917017875169'
// for telegram: `to` is numeric chat ID as string
```

### intelligence

```typescript
{
  provider: 'openai' | 'anthropic' | 'local' | 'nvidia',
  task: 'classification' | 'extraction' | 'qa' | 'reasoning',
  input: { text: '<string>' },
  options?: { /* task-specific */ }
}
```

Task-specific options:

| Task | Key option |
|---|---|
| `classification` | `categories: string[]` — allowed labels (LLM is constrained to these) |
| `extraction` | `fields: string[]` — field names to extract |
| `qa` | `question: string` — the question to answer |
| `reasoning` | none |

**Provider notes**:
- `'openai'`: uses `gpt-4o-mini`, model not overridable
- `'anthropic'`: uses `claude-haiku-4-5-20251001`, overridable via `options.model`
- `'local'`: Ollama-compatible (`http://localhost:11434` by default, model `deepseek-r1` by default)
- `'nvidia'`: NVIDIA NIM API, requires `NVIDIA_API_KEY` env var

---

## Module Output Contracts

### storage read/query output

```typescript
ctx.outputs?.['step-id'] as { rows: Record<string, string>[] | string[][] } | undefined
```

Row shape depends on whether the sheet has a header row (see `docs/modules.md`).

### storage write/update output (sheets)

```typescript
ctx.outputs?.['step-id'] as { updatedRange: string } | undefined
```

### storage write/read/update output (postgres)

```typescript
ctx.outputs?.['step-id'] as { rows: Record<string, unknown>[] } | undefined
```

### communication output

```typescript
ctx.outputs?.['step-id']  // null on success; step will be 'failed' if send failed
```

### intelligence output

```typescript
// classification
ctx.outputs?.['step-id'] as { label: string, confidence: number, reasoning: string } | undefined

// extraction
ctx.outputs?.['step-id'] as { fields: Record<string, string | null> } | undefined

// qa
ctx.outputs?.['step-id'] as { answer: string, confidence?: number } | undefined

// reasoning
ctx.outputs?.['step-id'] as { conclusion: string, steps: string[], confidence?: number } | undefined
```

---

## Flow Construction Checklist

Before submitting a generated flow, verify:

- [ ] `id` is unique and descriptive.
- [ ] Every step has a unique `id` within the flow.
- [ ] Every `type` is one of `'intelligence'`, `'storage'`, `'communication'` — no other values.
- [ ] All `input()` functions are pure — no `await`, no imports, no side effects.
- [ ] `ctx.outputs?.['step-id']` is read with optional chaining everywhere.
- [ ] Cast `ctx.outputs` values to their expected types — they are `unknown`.
- [ ] Phone numbers, sheet IDs, and API keys are read from `ctx.state.config`, not hard-coded.
- [ ] No imports from `storage-module`, `communication-module`, or `intelligence-module` inside the flow file.
- [ ] Only import from `engine-module` for types.
- [ ] Pre-validation and data shaping lives in `buildInitialContext()`, not in step `input()`.
- [ ] If a step should be optional, use `condition()` — not try/catch in `input()`.

---

## Complete Example

```typescript
import type { Flow, ExecutionContext } from 'engine-module';

// Pre-flow context builder — synchronous, no I/O
export function buildInitialContext(config: { ownerPhone: string; sheetId: string }) {
  return {
    event: {},
    state: { config },
  };
}

// Flow — all I/O
export const myReportFlow: Flow = {
  id: 'my-report-flow',
  steps: [
    // Step 1: read data from Sheets
    {
      id: 'fetch-data',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: ctx.state?.config?.sheetId as string,
        options: { range: 'Sheet1' },
      }),
    },

    // Step 2: classify the data using AI (only if rows exist)
    {
      id: 'classify',
      type: 'intelligence',
      condition: (ctx) => {
        const data = ctx.outputs?.['fetch-data'] as { rows: unknown[] } | undefined;
        return (data?.rows?.length ?? 0) > 0;
      },
      input: (ctx: ExecutionContext) => {
        const data = ctx.outputs?.['fetch-data'] as { rows: unknown[] };
        return {
          provider: 'anthropic',
          task: 'classification',
          input: { text: JSON.stringify(data.rows) },
          options: { categories: ['urgent', 'normal', 'low'] },
        };
      },
    },

    // Step 3: notify owner only if urgent
    {
      id: 'notify-owner',
      type: 'communication',
      condition: (ctx) => {
        const result = ctx.outputs?.['classify'] as { label: string } | undefined;
        return result?.label === 'urgent';
      },
      input: (ctx: ExecutionContext) => {
        const result = ctx.outputs?.['classify'] as { label: string; reasoning: string };
        return {
          provider: 'telegram',
          to: ctx.state?.config?.ownerPhone as string,
          message: `Urgent alert: ${result.reasoning}`,
        };
      },
    },
  ],
};
```
