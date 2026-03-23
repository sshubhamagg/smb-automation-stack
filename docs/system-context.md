# System Context

## 1. System Overview

### Purpose

This platform executes automation use cases as deterministic flows over a fixed module set.

Current capabilities in code:
- ingest inbound WhatsApp webhooks and normalize them
- run sequential business flows
- persist/read data through storage providers
- send outbound messages through communication providers
- call AI providers through a validated task pipeline
- expose app-level HTTP handlers and scheduled jobs

### How use cases are built

A production use case is built from these layers:
1. app/server receives trigger
2. app/handler normalizes inbound event, loads config, builds `Modules`, selects flow
3. optional `buildInitialContext()` performs synchronous validation/transforms
4. `runFlow(flow, context, modules)` executes sequential steps
5. each step calls exactly one module executor: `storage`, `communication`, or `intelligence`

`ingestion` is not a flow step type. It runs before the engine in app/server code.

## 2. Core Architecture

### Orchestrator

Orchestrator = app/server + app/handler code.

Current orchestrators:
- `apps/ledger/src/server.ts`
- `apps/ledger/src/handler.ts`
- `apps/mining/src/server.ts`
- `flows/mining-reporting/src/handler.ts`

Responsibilities:
- receive HTTP webhook or cron/manual trigger
- call `ingestion-module` for inbound WhatsApp
- load env/config
- build `Modules` object
- call `buildInitialContext()`
- call `runFlow()`
- handle `ExecutionResult`
- send pre-flow or flow-failure responses when needed

### Engine

Source:
- `modules/engine/src/runner.ts`
- `modules/engine/src/stepExecutor.ts`
- `modules/engine/src/types.ts`

Responsibilities:
- iterate steps in order
- evaluate `condition(ctx)` before a step
- call the module executor matching `step.type`
- write successful step outputs into `ctx.outputs[step.id]`
- stop on first failed step

The engine has no concrete module imports. It only knows the `Modules` map passed at runtime.

### Modules

Modules expose stable public entrypoints and hide provider-specific details.

Current flow-callable modules:
- `storage-module`
- `communication-module`
- `intelligence-module`

Pre-flow module:
- `ingestion-module`

Shared rule across module boundaries:
- module public functions return success/failure objects
- module public functions are intended not to throw
- adapters may throw internally; module entrypoints catch and wrap

### Adapters

Adapters implement provider-specific execution behind a registry.

Provider selection is data-driven:
- storage: `input.provider`
- communication: `input.provider ?? process.env.COMM_PROVIDER ?? 'twilio'`
- intelligence: `input.provider`
- ingestion: registry key is `${source}:${provider}`

## 3. Engine Contract

### Flow shape

```ts
type FlowStep = {
  id: string;
  type: 'intelligence' | 'storage' | 'communication';
  input?: (context: ExecutionContext) => unknown;
  condition?: (context: ExecutionContext) => boolean;
};

type Flow = {
  id: string;
  steps: FlowStep[];
};
```

### Execution rules

Rules from `modules/engine/src/runner.ts` and `modules/engine/src/stepExecutor.ts`:
- steps execute strictly in array order
- `condition(ctx) === false` skips the step
- skipped steps do not write anything to `ctx.outputs`
- step input defaults to `{}` when `input` is omitted
- engine looks up executor as `modules[step.type]`
- if executor missing, step fails
- if module returns `{ ok: false, error }`, step fails
- on first failed step, flow returns `ok: false` and stops
- on success, engine stores raw module output at `ctx.outputs[step.id]`

Critical implementation caveat:
- `condition()` is not wrapped in try/catch by the engine
- `input()` is not wrapped in try/catch before module execution
- if `condition()` or `input()` throws, `runFlow()` can reject instead of returning `ExecutionResult`
- therefore `condition()` and `input()` must be pure and non-throwing

### Return format

```ts
type StepResult =
  | { id: string; status: 'ok'; output: unknown }
  | { id: string; status: 'skipped' }
  | { id: string; status: 'failed'; error: string };

type ExecutionResult =
  | { ok: true; context: ExecutionContext; steps: StepResult[] }
  | { ok: false; failedStep: string; error: string; context: ExecutionContext; steps: StepResult[] };
```

## 4. Context Model

```ts
type ExecutionContext = {
  event?: any;
  outputs?: Record<string, unknown>;
  state?: Record<string, any>;
};
```

### `ctx.state.config`

Use for runtime config loaded outside the flow.

Observed usages:
- sheet IDs
- owner phone
- AI provider/mode
- managers map

Rules:
- config is injected by app/handler or `buildInitialContext()`
- do not hard-code sheet IDs, owner phones, API keys, or provider credentials in flow steps
- flow steps should read config from `ctx.state.config`

### `ctx.outputs`

Unified step output map keyed by step id.

Rules:
- only successful steps write to `ctx.outputs`
- skipped steps leave no key
- values are `unknown`; flow code must cast before use
- there are no per-module namespaces like `ctx.ai` or `ctx.storage`

### `ctx.event`

Original trigger payload for the flow after pre-normalization.

Observed shapes:
- ledger router: `{ message, user }`
- ledger entry/balance/summary/party/delete: event contains user phone and config payload
- mining report: `{ userId, message }`
- scheduled flows: often `{}` with config only in state

Rule:
- use `ctx.event` for request/event payload
- use `ctx.state` for derived values, parsed values, and config

## 5. Available Modules

### communication

Source:
- `modules/communication/src/main.ts`

Purpose:
- send outbound text messages via registered provider

Public entry:

```ts
execute(input: { to: string; message: string; provider?: string }): Promise<ModuleResult<null>>
```

Supported operations:
- send message

Provider selection:
- `input.provider`
- else `COMM_PROVIDER`
- else `'twilio'`

Providers:
- `meta`
- `twilio`
- `telegram`

Success output:

```ts
{ ok: true, output: null }
```

Failure output:

```ts
{ ok: false, error: string, reason?: 'adapter_not_found' }
```

Example step input:

```ts
{
  to: ctx.event?.phone_number,
  message: 'Entry recorded.',
  provider: 'meta'
}
```

Provider notes:
- `meta` sends WhatsApp via Meta Graph API
- `twilio` sends via Twilio Messages API
- `telegram` sends via Telegram Bot API
- `meta` requires `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN`
- `twilio` uses `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`
- `telegram` requires `TELEGRAM_BOT_TOKEN`

### storage

Source:
- `modules/storage/src/index.ts`

Purpose:
- abstract reads/writes/updates/query across storage providers

Public entry:

```ts
execute(input: StorageInput): Promise<StorageResult>
```

Input contract:

```ts
type StorageInput = {
  provider: string;
  operation: 'read' | 'write' | 'update' | 'query';
  resource: string;
  data?: any;
  query?: Record<string, any>;
  options?: Record<string, any>;
};
```

Providers:
- `sheets`
- `postgres`

#### storage / sheets

Adapter:
- `modules/storage/src/adapters/sheets.ts`

Operations:
- `read`
- `write`
- `update`
- `query`

Contracts:

`read`
```ts
{ provider: 'sheets', operation: 'read', resource: '<sheetId>', options?: { range?: string } }
```
Output:
```ts
{ rows: Record<string, string>[] | string[][] }
```

`write`
```ts
{ provider: 'sheets', operation: 'write', resource: '<sheetId>', data: string[], options: { range: string } }
```
Output:
```ts
{ updatedRange: string }
```

`update`
```ts
{
  provider: 'sheets',
  operation: 'update',
  resource: '<sheetId>',
  data: string[],
  options: { range: string, rowIndex: number }
}
```
Output:
```ts
{ updatedRange: string }
```

`query`
```ts
{
  provider: 'sheets',
  operation: 'query',
  resource: '<sheetId>',
  query: Record<string, string>,
  options: { range: string }
}
```
Output:
```ts
{ rows: Record<string, string>[] }
```

Sheets behavior that matters:
- `query` is in-memory search after reading rows
- search is exact-match, case-sensitive, AND across all filter fields
- if first sheet row is non-empty in all columns, provider treats it as header
- if sheet has no real header row, first data row is consumed as header and omitted from returned data
- some flows compensate with local `normalizeRows()` reconstruction
- Sheets provider setup requires valid `GOOGLE_SERVICE_ACCOUNT_JSON` at module initialization

Example step input:

```ts
{
  provider: 'sheets',
  operation: 'write',
  resource: ctx.state?.config?.sheetId,
  data: [date, type, amount, party, category, user],
  options: { range: 'Ledger' }
}
```

#### storage / postgres

Adapter:
- `modules/storage/src/adapters/postgres.ts`

Supported operations:
- `write` -> INSERT
- `read` -> SELECT
- `update` -> UPDATE

Unsupported:
- `query` returns `{ ok: false, reason: 'unknown_operation' }`

Contracts:

`write`
```ts
{ provider: 'postgres', operation: 'write', resource: '<table>', data: Record<string, unknown> }
```

`read`
```ts
{ provider: 'postgres', operation: 'read', resource: '<table>', query?: Record<string, unknown> }
```

`update`
```ts
{
  provider: 'postgres',
  operation: 'update',
  resource: '<table>',
  data: Record<string, unknown>,
  query: Record<string, unknown>
}
```

Output for successful postgres operations:

```ts
{ rows: Record<string, unknown>[] }
```

Notes:
- SQL is parameterized
- column names and table names are double-quoted
- `read` without `query` does full table select

Example step input:

```ts
{
  provider: 'postgres',
  operation: 'read',
  resource: 'reports',
  query: { mine: 'North Mine' }
}
```

### intelligence

Source:
- `modules/intelligence/src/index.ts`
- `modules/intelligence/src/pipeline.ts`

Purpose:
- run validated AI tasks through registered providers

Public entry:

```ts
run(input: AIInput): Promise<AIResult>
```

Input contract:

```ts
type AIInput = {
  provider: string;
  task: string;
  input: { text?: string; data?: unknown };
  options?: Record<string, any>;
};
```

Registered providers:
- `openai`
- `anthropic`
- `local`
- `nvidia`

Provider defaults in code:
- `openai` -> hardcoded model `gpt-4o-mini`
- `anthropic` -> default model `claude-haiku-4-5-20251001`
- `local` -> default base URL `http://localhost:11434`, default model `deepseek-r1`
- `nvidia` -> default base URL `https://integrate.api.nvidia.com/v1`, default model `meta/llama-3.1-8b-instruct`

Registered tasks:
- `classification`
- `extraction`
- `qa`
- `reasoning`

Pipeline:
1. resolve task handler
2. resolve adapter
3. build prompt
4. call provider
5. parse raw text into JSON object
6. validate task-specific schema
7. return validated output

Failure reasons:
- `unknown_task`
- `unknown_provider`
- `provider_error`
- `parse_error`
- `validation_error`

Task contracts:

`classification`
Input:
```ts
{
  provider,
  task: 'classification',
  input: { text },
  options: { categories: string[] }
}
```
Output:
```ts
{ label: string, confidence: number, reasoning: '' }
```

`extraction`
Input:
```ts
{
  provider,
  task: 'extraction',
  input: { text },
  options: { fields: string[] }
}
```
Output:
```ts
{ fields: Record<string, string | null> }
```

`qa`
Input:
```ts
{
  provider,
  task: 'qa',
  input: { text },
  options: { question: string }
}
```
Output:
```ts
{ answer: string, confidence?: number }
```

`reasoning`
Input:
```ts
{
  provider,
  task: 'reasoning',
  input: { text }
}
```
Output:
```ts
{ conclusion: string, steps: string[], confidence?: number }
```

Normalization/validation already enforced by module:
- raw provider text must parse into JSON object
- extraction coerces numbers to strings
- extraction normalizes amount strings for `lakh`, `crore`, `thousand`, currency symbols, commas
- classification clamps confidence into `[0,1]`
- parser strips `<think>...</think>` blocks and can extract JSON from code fences or substrings

Provider option caveat:
- current pipeline passes only `prompt` to adapters
- `AnthropicAdapter` supports `options.model`, but `pipeline.ts` does not pass adapter options
- therefore model selection is effectively fixed by adapter defaults/env wiring, not by per-step flow input

Example step input:

```ts
{
  provider: ctx.state?.config?.aiProvider ?? 'anthropic',
  task: 'classification',
  input: { text: ctx.event?.message ?? '' },
  options: { categories: ['add', 'balance', 'summary', 'ledger', 'delete'] }
}
```

### ingestion

Source:
- `modules/ingestion/src/index.ts`

Purpose:
- normalize inbound source/provider payload into canonical event before flow execution

Public entry:

```ts
receive(input: IngestionInput): Promise<IngestionResult>
```

Input contract:

```ts
type IngestionInput = {
  source: string;
  provider: string;
  payload: unknown;
  rawBody?: Buffer | string;
  headers?: Record<string, string>;
  secret?: string;
};
```

Current registered adapter:
- source `whatsapp` + provider `meta`

Success output:

```ts
{
  ok: true,
  event: {
    source: string,
    provider: string,
    userId: string,
    message?: string,
    raw: unknown,
    timestamp: number,
    metadata?: {
      messageId?: string,
      correlationId?: string,
      messageType?: string,
      receivedAt?: string,
      status?: string,
      phoneNumberId?: string
    }
  }
}
```

Failure variants:
- `signature_invalid`
- `validation_failed`
- `status_update`
- `unsupported_type`
- `adapter_error`

Observed behavior:
- signature verification only runs if `rawBody`, `headers`, and `secret` are all present
- current apps call `receive()` without those fields, so signature verification is skipped
- non-text inbound messages do not become flow events

Example pre-flow usage:

```ts
const result = await receive({ source: 'whatsapp', provider: 'meta', payload: req.body });
if (!result.ok) return;
await handleX({ phone_number: result.event.userId, text_body: result.event.message });
```

## 6. Adapter System

### Abstraction

Each module uses an in-memory registry.

Patterns:
- communication: `Map<string, CommunicationAdapter>`
- storage: `Map<string, StorageAdapter>`
- intelligence adapters: `Map<string, AIAdapter>`
- intelligence tasks: `Map<string, TaskHandler>`
- ingestion: `Map<string, Adapter>` keyed by `${source}:${provider}`

### Provider selection

Selection rules:
- storage executor requires `input.provider`
- intelligence executor requires `input.provider`
- communication provider can be omitted because module defaults to env/default
- ingestion requires both `source` and `provider`

To add a provider, code must:
1. implement adapter interface
2. register it in module init file
3. pass the provider name in flow/app input

No provider is selectable unless registered in code.

## 7. Flow Composition Rules

### Step definition

Each step must have:
- unique `id` within the flow
- `type` in `'storage' | 'communication' | 'intelligence'`

`input(ctx)` must:
- build plain data only
- do no I/O
- not throw

`condition(ctx)` must:
- return boolean
- not throw

### Chaining steps

Chaining is done only through `ctx.outputs[previousStepId]`.

Pattern:
1. step A writes output
2. step B reads `ctx.outputs?.['step-a']`
3. step B can be skipped if prior output absent or empty

Example from code:
- `ledger-entry` reads `check-duplicate` output before deciding to write
- `intent-router` reads `classify-intent` output before running extraction

### Using outputs

Rules:
- always use optional chaining on `ctx.outputs`
- cast output to expected shape before reading
- if a producing step was skipped, output key is `undefined`
- if a producing step failed, flow already stopped

### Using `condition()`

Use `condition()` only for branching/optional execution.

Good uses in code:
- run AI extraction only when classify label is `'add'`
- send duplicate warning only when duplicate query returned rows
- send missing-report notification only when missing mines array is non-empty

Do not use `condition()` for:
- expensive computation
- network/storage access
- parsing that can throw

### Pre-flow transforms

If data shaping is synchronous and deterministic, put it in `buildInitialContext()`.

Observed uses:
- parse structured command text
- resolve manager config
- validate authorized mine
- compute prepared row arrays

## 8. Constraints

Strict rules aligned to implementation:
- no direct API calls in flows
- no `fetch`, `axios`, SDK calls, or DB clients in flow files
- no module imports inside flow files for execution
- no side effects outside modules and orchestrator code
- no step types other than `storage`, `communication`, `intelligence`
- no reliance on `ctx.outputs` before a producing step runs
- no assumption that skipped steps wrote outputs
- no hard-coded runtime config inside steps
- no secrets in flows
- no module modifications when creating a normal use case unless adding a new platform capability is explicitly required
- no business logic inside module code
- ingestion is outside the engine; do not model inbound normalization as a flow step
- `condition()` and `input()` must not throw
- flows must tolerate `unknown` output types by explicit casting
- for Postgres, do not use `operation: 'query'`
- for Sheets, `query` requires `options.range`

## 9. Patterns

### ingestion -> parse -> store -> notify

Use when inbound external messages must be normalized before business flow.

Implementation shape:
1. app/server calls `receive()`
2. handler maps normalized event into domain event
3. `buildInitialContext()` performs deterministic parse/validation
4. flow stores data with `storage`
5. flow sends confirmation and downstream notification with `communication`

Reference:
- mining reporting

### query -> aggregate -> respond

Use when data already exists and response is deterministic.

Implementation shape:
1. read/query from storage
2. aggregate in step `input()` for message step or precompute helper
3. send response through communication

Reference:
- ledger balance
- ledger summary
- ledger party
- missed reports
- daily summary

### AI -> normalize -> route

Use when free-form user input must map into deterministic flows.

Implementation shape:
1. classify with `intelligence`
2. conditionally extract structured fields
3. normalize extracted fields into domain payload
4. handler resolves `nextFlow`
5. handler dispatches to concrete deterministic flow

Reference:
- ledger intent router

## 10. AI Usage Rules

Use AI only where the codebase already uses it well:
- free-text intent classification
- free-text field extraction
- constrained QA over supplied text
- structured reasoning output

Do not use AI for:
- arithmetic totals
- balance computation
- duplicate detection
- exact row filtering
- manager authorization
- parsing fixed-format messages that deterministic code can handle
- provider selection

Normalization requirements:
- AI output must flow through `intelligence-module` validators
- downstream flow code should still normalize domain-specific fields before routing or storage
- when deterministic parsing works, prefer deterministic parsing and bypass AI
- current ledger router always tries deterministic structured parsing first, even in AI mode

## 11. Example Flows

### `ledger-entry`

Structure:
1. `buildInitialContext()` parses `add <credit|debit> <amount> <party> [category]`
2. `check-duplicate` queries Sheets by `Type`, `Amount`, `Party`, `User`
3. `write-to-sheet` runs only if no duplicate
4. `send-success` runs only if write path executed
5. `send-duplicate-warning` runs only if duplicate found

Purpose:
- deterministic ledger insert with duplicate guard and user response

### `ledger-balance`

Structure:
1. read full `Ledger` sheet
2. compute credits/debits/net in communication step input
3. send formatted balance message

Purpose:
- deterministic query -> aggregate -> respond

### `intent-router`

Structure:
1. `buildInitialContext()` tries deterministic parsing first
2. optional `classify-intent` AI step when structured parse failed and mode is `ai`
3. optional `extract-transaction` AI step when classification is `add`
4. optional `send-invalid` help step in structured mode
5. handler reads `ctx.state.structured` or `ctx.outputs` through `resolveRouting()`
6. handler dispatches to downstream concrete flow

Purpose:
- isolate AI routing from business side effects

## 12. Quick Recipes

### To build a WhatsApp data ingestion flow

Pattern:
1. accept webhook in app server
2. call `receive({ source: 'whatsapp', provider: 'meta', payload: req.body })`
3. ignore `status_update`
4. require `result.ok === true` and `event.message`
5. hand off to app/handler
6. do synchronous parse/validation in `buildInitialContext()`
7. flow: `storage` write -> `communication` confirmation -> optional owner notification

### To build a reporting system

Pattern:
1. schedule or trigger from app server
2. create context with `state.config`
3. flow step 1: `storage` read
4. flow step 2: aggregate deterministically
5. flow step 3: `communication` send report

### To build a free-text command router

Pattern:
1. deterministic parse first in `buildInitialContext()`
2. if parse fails and feature requires AI, run `classification`
3. if classification implies structured payload, run `extraction`
4. normalize AI output into concrete domain payload
5. handler dispatches to deterministic downstream flows

### To build a store-and-notify workflow

Pattern:
1. validate payload synchronously
2. construct storage row/object in `ctx.state`
3. storage write
4. success confirmation to submitter
5. secondary notification to owner/stakeholder

## 13. Output Requirements

### Required deliverables for a new use case

Generate all required files, not just a flow object.

#### If target is `ledger`

Use this shape:
- `flows/ledger/<use-case>/flow.ts`
- update `apps/ledger/src/handler.ts` to import flow and route to it
- only update `apps/ledger/src/server.ts` if a new external trigger is required

Flow file should contain:
- event/config types
- `buildInitialContext(...)`
- exported `Flow` object
- optional pure helper functions

#### If target is mining-style or a standalone use case

Use this shape:
- `flows/<use-case>/src/flow.ts`
- optional `flows/<use-case>/src/handler.ts` when pre-flow failure handling or custom orchestration is needed
- update `apps/mining/src/server.ts` or the relevant app server to wire trigger/cron/manual endpoint

### `flow.ts` format

Minimum format:

```ts
import type { Flow, ExecutionContext } from 'engine-module';

export function buildInitialContext(...) {
  return {
    ok: true,
    context: {
      event: ...,
      state: {
        config: ...,
        ...
      }
    }
  };
}

export const someFlow: Flow = {
  id: 'some-flow',
  steps: [
    {
      id: 'step-id',
      type: 'storage' | 'communication' | 'intelligence',
      condition: (ctx: ExecutionContext) => boolean,
      input: (ctx: ExecutionContext) => ({ ... })
    }
  ]
};
```

Requirements:
- keep helper logic pure
- keep step ids unique
- return safe values from `input()` and `condition()`
- read config from `ctx.state.config`
- read previous outputs from `ctx.outputs?.[...]`

### Handler wiring

Handler must:
1. load config from env/files
2. build `Modules`
3. call `buildInitialContext()`
4. handle `{ ok: false }` from context builder with user-visible or logged failure path
5. call `runFlow(flow, context, modules)`
6. inspect `result.ok`
7. send fallback error response or log as appropriate

Current `Modules` construction pattern:

```ts
const modules: Modules = {
  storage: (input) => storageExecute(input as Parameters<typeof storageExecute>[0]),
  communication: (input) => communication.execute(input as { to: string; message: string }),
  intelligence: (input) => intelligenceRun(input as any),
};
```

## 14. Validation Checklist For Generated Use Cases

Use this before finalizing generated code:
- flow uses only valid step types
- all step ids are unique
- all `condition()` and `input()` functions are pure and non-throwing
- no direct API/DB calls in flows
- no module execution imports in flow files
- all runtime config comes from app/env into `ctx.state.config`
- all prior outputs are read via `ctx.outputs?.['step-id']`
- skipped-step `undefined` cases are handled
- deterministic logic is not delegated to AI
- AI outputs are normalized before storage/routing
- orchestration code wires trigger -> context -> `runFlow()`
- storage provider/operation combination is valid
- communication provider assumptions are explicit
- inbound webhook normalization uses `ingestion-module`, not custom parsing in the flow

This document is sufficient to generate a production-ready use case only if all generated code stays inside these contracts.
