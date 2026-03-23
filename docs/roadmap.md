# Extension Points

Identified places in the architecture where new capabilities can be added cleanly without breaking existing behavior. For prioritized work items and bugs, see `docs/backlog.md`.

Identified from existing architecture. These are not planned features — they are places in the code where extensions can be inserted cleanly without breaking existing behavior.

---

## Flow Registry

**Current state**: Flows are imported directly into each app (`apps/mining/src/server.ts`, `apps/ledger/src/handler.ts`) and passed to `runFlow()` explicitly.

**Extension point**: Between the orchestrator's trigger handlers and `runFlow()`.

A `registerFlow(id: string, flow: Flow)` function could sit alongside the adapter registries, allowing flows to be loaded by ID:

```typescript
// Hypothetical
const flow = getFlow('my-flow');
const result = await runFlow(flow, ctx, modules);
```

This would enable dynamic flow lookup, hot-reload without restart, and external flow configuration.

**What needs to change**: A new `flow-registry.ts` file. No engine changes required.

---

## Fourth Step Type — e.g., `'notification'`, `'state'`, `'transform'`

**Current state**: `Modules` is `Partial<Record<'intelligence' | 'storage' | 'communication', ModuleExecutor>>` in `modules/engine/src/types.ts:7`.

**Extension point**: `types.ts` union type + `Modules` record.

Adding a fourth module type requires two edits:
1. Extend `FlowStep.type` union.
2. Extend `Modules` record key.
3. Create the new module following the standard contract.
4. Wire it in the orchestrator's `modules` object.

No runner or stepExecutor changes needed.

---

## Persistent State Layer

**Current state**: `ExecutionContext.state` is ephemeral — created per invocation, discarded after `runFlow()` returns.

**Extension point**: A `'state'` step type (see above) could read/write from a persistent store (Redis, Postgres).

Pattern:
```typescript
// hypothetical step
{
  id: 'check-already-reported',
  type: 'state',
  input: (ctx) => ({ operation: 'get', key: `reported:${ctx.event?.userId}:${today}` }),
}
```

This would enable webhook-level idempotency (currently missing) and cross-invocation state without requiring a dedicated database step in every flow.

---

## Observability Hook in Engine

**Current state**: `modules/engine/src/runner.ts` iterates steps and collects `StepResult[]`. No timing, no tracing, no metrics.

**Extension point**: After `executeStep()` returns (line 19 in `runner.ts`), a hook could emit per-step telemetry:

```typescript
// Hypothetical signature addition to runFlow:
export async function runFlow(
  flow: Flow,
  initialContext: ExecutionContext,
  modules: Modules,
  hooks?: { onStepComplete?: (result: StepResult, durationMs: number) => void }
): Promise<ExecutionResult>
```

This would give Prometheus/Datadog/CloudWatch visibility into step-level latency and failure rates without changing the execution model.

---

## Webhook Signature Verification

**Current state**: `modules/ingestion/src/adapters/meta.ts` already implements HMAC-SHA256 verification. It is opt-in: only runs when `rawBody + headers + secret` are all passed to `receive()`.

**Extension point**: The orchestrator's `POST /webhook` handler (`server.ts:199`).

To activate:
1. Add `express.raw()` middleware to capture the raw request body before JSON parsing.
2. Pass `rawBody`, `headers['x-hub-signature-256']`, and `process.env.WHATSAPP_APP_SECRET` to `receive()`.

No module changes required. The verification logic is already implemented.

---

## Multi-Sheet / Per-Manager Storage Routing

**Current state**: `managers.json` already has a `sheetId` per manager entry. Mining-reporting uses `ctx.state.config.sheetId` per flow invocation.

**Extension point**: The daily-summary and missed-reports flows currently use a single global `SHEET_ID`. If each manager needs their own sheet, the orchestrator would need to run a flow per manager or extend the flow to iterate managers internally.

The data model (`managers.json` schema) already supports per-manager `sheetId`. Only the orchestrator context initialization and flow aggregation logic need updating.

---

## Flow DSL / External Configuration

**Current state**: Flows are TypeScript objects with functions (`input()`, `condition()`). They cannot be serialized to JSON because functions are not JSON-serializable.

**Extension point**: A limited expression language for `input()` and `condition()` could enable flows to be defined in JSON/YAML and stored in a database.

This is a significant architectural change (requires a DSL interpreter). The constraint is that `input()` and `condition()` are currently arbitrary TypeScript functions.

**Intermediate option**: Flows that only need simple field mappings (no computed logic) could be generated from a JSON schema that produces typed `input()` functions — a code-generation approach rather than a runtime interpreter.
