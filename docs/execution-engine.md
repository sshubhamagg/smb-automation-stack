# Execution Engine

**Package**: `engine-module`
**Source**: `modules/engine/src/`
**Only dependency**: `shared-types`

---

## Overview

The execution engine is the orchestration layer of the SMB Automation Stack. It takes a flow (an ordered array of steps), an initial context, and a map of module executors, then runs each step sequentially, accumulating outputs into a shared context.

The engine has no business logic and no concrete module imports. All module wiring happens at the call site (app/handler). The engine only knows the abstract `Modules` map it receives at runtime.

---

## Public API

```typescript
import { runFlow } from 'engine-module';
import type { Flow, FlowStep, ExecutionContext, ExecutionResult, StepResult, Modules, ModuleExecutor } from 'engine-module';
```

---

## Types

### `ModuleExecutor`

```typescript
type ModuleExecutor = (input: unknown) => Promise<ModuleResult<unknown>>;
```

A normalized function signature for any module. Every module's public execute/run function must be compatible with this type. The engine only calls modules through this interface.

---

### `Modules`

```typescript
type Modules = Partial<Record<'intelligence' | 'storage' | 'communication', ModuleExecutor>>;
```

The map of executors passed to `runFlow()`. Only include what the flow uses. A step whose `type` has no corresponding entry in `Modules` produces an immediate `'failed'` result.

---

### `ExecutionContext`

```typescript
type ExecutionContext = {
  event?: any;                        // triggering event — set by caller before runFlow()
  outputs?: Record<string, unknown>;  // step outputs — keyed by step id, written by engine
  state?: Record<string, any>;        // caller-defined data — config, pre-computed values
};
```

The context is a shallow copy of `initialContext` at the start of `runFlow()`. The original is never mutated. All step outputs accumulate under `ctx.outputs[stepId]`.

- `ctx.event` — carries the normalized inbound event or trigger payload
- `ctx.state` — carries config, pre-parsed values, manager maps, and any caller-injected data
- `ctx.outputs` — written exclusively by the engine after each successful step

---

### `FlowStep`

```typescript
type FlowStep = {
  id: string;
  type: 'intelligence' | 'storage' | 'communication';
  input?: (context: ExecutionContext) => unknown;     // defaults to {} if omitted
  condition?: (context: ExecutionContext) => boolean; // false = skip (not fail)
};
```

- `id` must be unique within the flow
- `type` maps to the executor key in `Modules`
- `input(ctx)` must be pure and non-throwing; it builds the raw input passed to the module
- `condition(ctx)` must be pure and non-throwing; returning `false` skips the step without failing the flow

**Critical**: neither `condition()` nor `input()` is wrapped in try/catch by the engine. If either throws, `runFlow()` will reject instead of returning an `ExecutionResult`. Keep them pure.

---

### `Flow`

```typescript
type Flow = {
  id: string;
  steps: FlowStep[];
};
```

A flow is just an identifier and an ordered array of steps. The engine iterates `steps` in array order with no parallelism.

---

### `StepResult`

```typescript
type StepResult =
  | { id: string; status: 'ok';      output: unknown }
  | { id: string; status: 'skipped'                  }
  | { id: string; status: 'failed';  error: string   };
```

One result per step in the flow. All results — including skipped and failed — are included in the `ExecutionResult.steps` array for post-run inspection.

---

### `ExecutionResult`

```typescript
type ExecutionResult =
  | { ok: true;  context: ExecutionContext; steps: StepResult[]                              }
  | { ok: false; failedStep: string; error: string; context: ExecutionContext; steps: StepResult[] };
```

Both variants always return `context` and `steps`, making post-run inspection possible regardless of outcome.

---

## `runFlow()` — `modules/engine/src/runner.ts`

```typescript
export async function runFlow(
  flow: Flow,
  initialContext: ExecutionContext,
  modules: Modules,
): Promise<ExecutionResult>
```

### Execution model

```
context = { ...initialContext }    // shallow copy — caller's object is never mutated

for each step of flow.steps:
  if step.condition exists and step.condition(context) === false:
    push { id, status: 'skipped' }
    continue                        // skip — does NOT write to ctx.outputs

  { result, output } = await executeStep(step, context, modules)
  push result

  if result.status === 'failed':
    return { ok: false, failedStep: step.id, error: result.error, context, steps }   // stop immediately

  context.outputs ??= {}
  context.outputs[step.id] = output  // available to all subsequent steps

return { ok: true, context, steps }
```

### Guarantees

- Steps never execute in parallel.
- A failed step stops the flow; no subsequent steps are called.
- A skipped step does not write to `ctx.outputs` — reading `ctx.outputs?.['skipped-step-id']` returns `undefined`.
- `runFlow()` itself never throws — all failure modes return `{ ok: false }`.
- The original `initialContext` object is never mutated.

---

## `executeStep()` — `modules/engine/src/stepExecutor.ts`

```typescript
export async function executeStep(
  step: FlowStep,
  context: ExecutionContext,
  modules: Modules,
): Promise<{ result: StepResult; output: unknown }>
```

### Logic

1. Calls `step.input(context)` — or `{}` if `input` is undefined.
2. Looks up `modules[step.type]`. If not present → returns `{ status: 'failed', error: 'No module provided for step type: ...' }`.
3. Calls `executor(rawInput)` inside a try/catch.
4. If executor throws → `{ status: 'failed', error: err.message }`.
5. If `res.ok === false` → `{ status: 'failed', error: res.error }`.
6. If `res.ok === true` → `{ status: 'ok', output: res.output }`.

The step executor never throws. All failure modes are returned as a `StepResult`.

---

## Module Wiring

The caller (app/handler) constructs the `Modules` map before calling `runFlow()`. This is the only place where concrete module functions are referenced.

```typescript
import { execute as storageExecute } from 'storage-module';
import { execute as communicationExecute } from 'communication-module';
import { run as intelligenceRun } from 'intelligence-module';
import type { Modules } from 'engine-module';

const modules: Modules = {
  storage:       (input) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input) => communicationExecute(input as { to: string; message: string }),
  intelligence:  (input) => intelligenceRun(input as any),
};
```

---

## Step Types and Module Contracts

### `storage`

Routes to `storage-module`. Input must conform to `StorageInput`:

```typescript
{
  provider: 'sheets' | 'postgres';
  operation: 'read' | 'write' | 'update' | 'query';
  resource: string;               // sheetId or table name
  data?: any;
  query?: Record<string, any>;
  options?: Record<string, any>;
}
```

Output shape: `{ rows: ... }` or `{ updatedRange: string }` depending on operation.

### `communication`

Routes to `communication-module`. Input must conform to:

```typescript
{
  to: string;        // E.164 phone number or chat ID
  message: string;
  provider?: string; // 'meta' | 'twilio' | 'telegram' — defaults to COMM_PROVIDER env or 'twilio'
}
```

Always returns `{ ok: true, output: null }` on success.

### `intelligence`

Routes to `intelligence-module`. Input must conform to `AIInput`:

```typescript
{
  provider: 'openai' | 'anthropic' | 'local' | 'nvidia';
  task: 'classification' | 'extraction' | 'qa' | 'reasoning';
  input: { text?: string; data?: unknown };
  options?: Record<string, any>;
}
```

Output shape varies by task — see `docs/system-context.md §5`.

---

## Context Patterns

### Reading config in steps

Config is injected into `ctx.state.config` by the app/handler before calling `runFlow()`. Steps read it via `ctx.state?.config`:

```typescript
input: (ctx) => ({
  provider: 'sheets',
  operation: 'write',
  resource: ctx.state?.config?.sheetId,
  data: [ctx.state?.row],
  options: { range: 'Ledger' },
})
```

### Chaining outputs between steps

A step reads a previous step's output via `ctx.outputs?.['previous-step-id']`:

```typescript
{
  id: 'send-result',
  type: 'communication',
  condition: (ctx) => !!(ctx.outputs?.['check-duplicate'] as any)?.isDuplicate === false,
  input: (ctx) => ({
    to: ctx.event?.phone,
    message: `Recorded: ${(ctx.outputs?.['extract'] as any)?.fields?.amount}`,
    provider: 'meta',
  }),
}
```

### Conditional steps

A step is skipped (not failed) when its `condition()` returns `false`:

```typescript
{
  id: 'send-duplicate-warning',
  type: 'communication',
  condition: (ctx) => {
    const result = ctx.outputs?.['check-duplicate'] as { rows: unknown[] } | undefined;
    return Array.isArray(result?.rows) && result.rows.length > 0;
  },
  input: (ctx) => ({
    to: ctx.event?.phone,
    message: 'Duplicate entry detected — not recorded.',
    provider: 'meta',
  }),
}
```

---

## Building a Flow — Checklist

Before writing a flow:

- [ ] All step `id` values are unique within the flow
- [ ] `type` is one of `'storage' | 'communication' | 'intelligence'`
- [ ] `condition()` is pure, synchronous, and non-throwing
- [ ] `input()` is pure, synchronous, and non-throwing
- [ ] No direct API calls, SDK calls, or DB clients in `input()` or `condition()`
- [ ] No module imports in the flow file for execution purposes
- [ ] All runtime config comes from `ctx.state.config`
- [ ] All prior outputs are read via `ctx.outputs?.['step-id']` with optional chaining
- [ ] Skipped-step `undefined` cases are handled (steps may have been skipped)
- [ ] Outputs are cast from `unknown` before use (e.g., `ctx.outputs?.['step-id'] as MyType`)

---

## Tests

Test file: `modules/engine/tests/runner.test.ts`

| Test | Verifies |
|------|---------|
| executes steps sequentially and accumulates outputs | Sequential execution, output chaining, step result shape |
| skips steps whose condition evaluates to false | Condition eval, skip does not call executor, skip recorded in steps |
| stops the flow on first failed step | Fail-fast, subsequent steps not called, `ok: false` result shape |
| captures executor exceptions as failed steps | try/catch in `executeStep`, exception → `status: 'failed'` |
| returns failed step when module is not provided | Missing executor handling |
| passes initial context state to the first step | `ctx.state` available in `input()` from start |

Run with:

```bash
cd modules/engine
npm test
```

---

## Reliability Mechanisms

These are NOT implemented in the engine. They live in app-level code.

| Mechanism | Location | Purpose |
|-----------|----------|---------|
| Throttle | `apps/mining/src/server.ts` | Min 2s between scheduled runs |
| Retry | `apps/mining/src/server.ts` | 3 attempts, 2s delay, cron flows only |
| Idempotency | `apps/mining/src/server.ts` | Prevents same cron flow running twice in one day |
| Concurrency lock | `apps/mining/src/server.ts` | Boolean flag prevents overlapping execution |

The engine itself is stateless and makes no guarantees about retry or idempotency. Those concerns belong to the caller.

---

## Constraints

1. **Engine has no concrete module imports** — only dependency is `shared-types`
2. **No parallelism** — `for...of` loop, never `Promise.all`
3. **Fail-fast** — first failed step stops the flow immediately
4. **No business logic** — engine executes steps; flows define what to do
5. **No hard-coded providers** — provider names travel in `step.input(ctx)` output
6. **No mutation of `initialContext`** — shallow copy made at start of `runFlow()`
7. **`condition()` and `input()` must not throw** — not wrapped in try/catch by the engine
