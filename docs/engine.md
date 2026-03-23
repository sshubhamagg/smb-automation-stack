# Engine

**Package name**: `engine-module`
**Files**: `modules/engine/src/`
**Only dependency**: `shared-types`

---

## Types

All types are in `modules/engine/src/types.ts` and re-exported from `modules/engine/src/index.ts`.

### `ModuleExecutor`

```typescript
type ModuleExecutor = (input: unknown) => Promise<ModuleResult<unknown>>;
```

A normalized function signature for any module. The engine only calls executors through this type.

### `Modules`

```typescript
type Modules = Partial<Record<'intelligence' | 'storage' | 'communication', ModuleExecutor>>;
```

The map of executors passed to `runFlow()`. Only include what the flow uses. Missing entries produce a `'failed'` step result.

### `ExecutionContext`

```typescript
type ExecutionContext = {
  event?: any;                       // triggering event — set by caller before runFlow()
  outputs?: Record<string, unknown>; // step outputs — keyed by step id, written by engine
  state?: Record<string, any>;       // caller-defined data — config, pre-computed values
};
```

### `FlowStep`

```typescript
type FlowStep = {
  id: string;
  type: 'intelligence' | 'storage' | 'communication';
  input?: (context: ExecutionContext) => unknown;    // defaults to {} if omitted
  condition?: (context: ExecutionContext) => boolean; // false = skip (not fail)
};
```

### `Flow`

```typescript
type Flow = {
  id: string;
  steps: FlowStep[];
};
```

### `StepResult`

```typescript
type StepResult =
  | { id: string; status: 'ok'; output: unknown }
  | { id: string; status: 'skipped' }
  | { id: string; status: 'failed'; error: string };
```

### `ExecutionResult`

```typescript
type ExecutionResult =
  | { ok: true;  context: ExecutionContext; steps: StepResult[] }
  | { ok: false; failedStep: string; error: string; context: ExecutionContext; steps: StepResult[] };
```

Both variants always include `context` and `steps` for post-run inspection.

---

## `runFlow()` — `modules/engine/src/runner.ts`

```typescript
export async function runFlow(
  flow: Flow,
  initialContext: ExecutionContext,
  modules: Modules,
): Promise<ExecutionResult>
```

Execution model (from `runner.ts`):

```
context = { ...initialContext }   // shallow copy — original is never mutated

for each step in flow.steps:
  if step.condition(context) === false:
    push { id, status: 'skipped' }
    continue to next step

  { result, output } = await executeStep(step, context, modules)
  push result

  if result.status === 'failed':
    return { ok: false, failedStep: step.id, error: result.error, context, steps }   // stop immediately

  context.outputs ??= {}
  context.outputs[step.id] = output   // available to all subsequent steps

return { ok: true, context, steps }
```

**Guarantees**:
- Steps never run in parallel.
- A failed step stops the flow; subsequent steps are never called.
- A skipped step does not write to `ctx.outputs` — reading `ctx.outputs?.['skipped-step-id']` returns `undefined`.
- `runFlow()` itself never throws.

---

## `executeStep()` — `modules/engine/src/stepExecutor.ts`

```typescript
export async function executeStep(
  step: FlowStep,
  context: ExecutionContext,
  modules: Modules,
): Promise<{ result: StepResult; output: unknown }>
```

Logic:
1. Calls `step.input(context)` — or `{}` if `input` is undefined.
2. Looks up `modules[step.type]`. If not present → `{ status: 'failed', error: 'No module provided for step type: ...' }`.
3. Calls `executor(rawInput)` inside a try/catch.
4. If executor throws → `{ status: 'failed', error: err.message }`.
5. If `res.ok === false` → `{ status: 'failed', error: res.error }`.
6. If `res.ok === true` → `{ status: 'ok', output: res.output }`.

The step executor never throws. All failure modes return a `StepResult`.

---

## Public API

```typescript
import { runFlow } from 'engine-module';
import type { Flow, ExecutionContext, Modules } from 'engine-module';
```

---

## Reliability Mechanisms

These are implemented in the apps (`apps/mining/src/server.ts`), not in the engine itself. They apply only to scheduled flows in the mining app.

### Throttle

Minimum 2-second interval between scheduled flow invocations. `throttle()` is called before each cron-triggered flow run.

```typescript
// apps/mining/src/server.ts
const MIN_INTERVAL_MS = 2000;
async function throttle(): Promise<void> { ... }
```

### Retry

3 attempts with 2-second delay between attempts. Applied only to cron-triggered `runFlow()` calls.

```typescript
// apps/mining/src/server.ts
async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T>
```

### Idempotency (Cron flows only)

In-memory `Map<string, boolean>` keyed by `'flowName:YYYY-MM-DD'`. Prevents a cron flow from running twice on the same calendar day.

```typescript
// apps/mining/src/server.ts
const executionRegistry = new Map<string, boolean>();
function getTodayKey(flowName: string): string { ... }  // e.g. 'daily-summary:2026-03-20'
```

**Limitation**: Registry is in-memory. Lost on process restart.

### Concurrency Lock

Boolean flags prevent overlapping executions of the same scheduled flow. Managed via `try/finally` so flags are always cleared.

```typescript
// apps/mining/src/server.ts
let isRunningDailySummary = false;
let isRunningMissedReports = false;
```

### Cron Schedule

```typescript
// apps/mining/src/server.ts (library: node-cron)
cron.schedule('0 18 * * *', () => runMissedReports());  // 18:00 daily
cron.schedule('0 20 * * *', () => runDailySummary());   // 20:00 daily
```

Timezone: server local timezone (not explicitly configured).
