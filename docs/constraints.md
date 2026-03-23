# System Constraints

Hard rules enforced by the architecture. Each is traceable to code.

---

## 1. Modules never throw at their public boundary

**Enforced by**: Comment at top of every module entry file + try/catch wrapping all adapter calls.

```typescript
// Comment in modules/storage/src/index.ts, communication/src/main.ts, intelligence/src/pipeline.ts:
// Standard Module Contract:
// - Never throw
// - Always return { ok: true | false }
```

All exceptions from adapters are caught and returned as `{ ok: false, error: '...' }`.

---

## 2. The engine has no knowledge of concrete modules

**Enforced by**: `modules/engine/package.json` — the only dependency is `shared-types`.

The engine receives a `Modules` object at call time:

```typescript
// modules/engine/src/types.ts
type Modules = Partial<Record<'intelligence' | 'storage' | 'communication', ModuleExecutor>>;
```

It calls `modules[step.type](input)`. It does not import or reference any module implementation.

---

## 3. Steps execute sequentially — no parallelism

**Enforced by**: `modules/engine/src/runner.ts:12` — `for (const step of flow.steps)`.

There is no `Promise.all`, no worker pool, no concurrent execution anywhere in the engine.

---

## 4. Fail-fast: first failed step stops the flow

**Enforced by**: `modules/engine/src/runner.ts:23-25`.

```typescript
if (result.status === 'failed') {
  return { ok: false, failedStep: step.id, error: result.error, context, steps };
}
```

Subsequent steps are never called. Their `input()` functions never execute.

---

## 5. Only three step types exist

**Enforced by**: `modules/engine/src/types.ts:7`.

```typescript
type Modules = Partial<Record<'intelligence' | 'storage' | 'communication', ModuleExecutor>>;
```

A step with any other `type` value will result in `modules[step.type]` being `undefined`, which immediately returns `{ status: 'failed', error: 'No module provided for step type: ...' }`.

---

## 6. Flows import only from `engine-module`

**Enforced by**: Flow `package.json` files do not list `storage-module`, `communication-module`, etc. as dependencies.

Flows define what to do (via `input()` functions). The app (`apps/ledger/` or `apps/mining/`) decides which concrete modules fulfill those instructions.

---

## 7. Modules never import each other

**Enforced by**: No cross-module imports anywhere in `modules/`. The ingestion adapter imports from `modules/whatsapp/src/` via relative paths — this is a direct source dependency on the whatsapp module's shared utility functions, not a module-to-module call.

---

## 8. Adapter selection is runtime data, not compile-time code

**Enforced by**: The registry pattern in every module. Provider names travel in `input.provider` and are resolved via `getAdapter(provider)` at call time. There are no `if/switch` chains over provider names in module logic.

---

## 9. `ctx.outputs` uses unified namespace keyed by step ID

**Enforced by**: `modules/engine/src/runner.ts:28-29`.

```typescript
context.outputs ??= {};
context.outputs[step.id] = output;
```

All step outputs go into `ctx.outputs`. There are no `ctx.ai`, `ctx.storage`, `ctx.communication` namespaces.

---

## 10. StorageResult uses `output`, not `data`

**Enforced by**: `modules/storage/src/types.ts:16-18`.

```typescript
type StorageResult<T = any> =
  | { ok: true; output: T; metadata?: any }
  | { ok: false; reason?: string; error: string };
```

The field is `output`, not `data`. Code or documentation referencing `result.data` for storage results is incorrect.

---

## 11. Provider name in communication follows priority order

**Enforced by**: `modules/communication/src/main.ts:19`.

```typescript
const provider = input.provider ?? (process.env.COMM_PROVIDER ?? 'twilio');
```

Priority: `input.provider` → `COMM_PROVIDER` env var → `'twilio'` (hardcoded fallback).

---

## 12. Webhook is acknowledged immediately before processing

**Enforced by**: Both `apps/ledger/src/server.ts` and `apps/mining/src/server.ts`.

```typescript
res.sendStatus(200);  // ACK before any processing
setImmediate(async () => { ... });  // processing runs outside request cycle
```

Meta requires a 200 response within 20 seconds. Processing runs asynchronously to avoid blocking.
