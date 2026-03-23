# Developer Guide

---

## How to Add a New Flow

### Step 1 — Create the flow directory

```bash
mkdir -p flows/my-flow/src
```

### Step 2 — Create `flows/my-flow/package.json`

```json
{
  "name": "my-flow",
  "version": "1.0.0",
  "main": "src/flow.ts",
  "dependencies": {
    "engine-module": "file:../../modules/engine"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0"
  }
}
```

Flows only declare `engine-module` as a dependency. They do NOT import concrete modules (`storage-module`, etc.) — those are wired by the app.

### Step 3 — Write `flows/my-flow/src/flow.ts`

```typescript
import type { Flow, ExecutionContext } from 'engine-module';

export const myFlow: Flow = {
  id: 'my-flow',
  steps: [
    {
      id: 'read-data',
      type: 'storage',
      input: (ctx: ExecutionContext) => ({
        provider: 'sheets',
        operation: 'read',
        resource: ctx.state?.config?.sheetId as string,
        options: { range: 'Sheet1' },
      }),
    },
    {
      id: 'send-result',
      type: 'communication',
      condition: (ctx) => {
        const data = ctx.outputs?.['read-data'] as { rows: unknown[] } | undefined;
        return (data?.rows?.length ?? 0) > 0;
      },
      input: (ctx: ExecutionContext) => ({
        to: ctx.state?.config?.ownerPhone as string,
        message: `Found data.`,
      }),
    },
  ],
};
```

If synchronous pre-processing is needed, add a `buildInitialContext()` function (see `flows/mining-reporting/src/flow.ts` for the pattern).

### Step 4 — Wire in the app

For a scheduled flow, add to `apps/mining/src/server.ts`:

```typescript
// Add import
import { myFlow } from '../../../flows/my-flow/src/flow';

// Add HTTP trigger
app.post('/run/my-flow', async (_req: Request, res: Response) => {
  const ctx: ExecutionContext = {
    event: {},
    state: { config: { ownerPhone: OWNER_PHONE, sheetId: SHEET_ID } },
  };
  const result = await runFlow(myFlow, ctx, modules);
  res.json(result);
});

// Or add cron trigger
cron.schedule('0 9 * * *', async () => {
  const ctx: ExecutionContext = { ... };
  await runFlow(myFlow, ctx, modules);
});
```

For a message-driven flow, add to `apps/ledger/src/handler.ts` or create a new handler in the relevant app.

### Step 5 — Install the flow package

Add to the app's `package.json`:
```json
"my-flow": "file:../../flows/my-flow"
```

Then run `npm install` in the app directory.

---

## How to Add a New Storage Adapter

1. Create `modules/storage/src/adapters/my-provider.ts` implementing `StorageAdapter`:

```typescript
import type { StorageAdapter, StorageInput, StorageResult } from '../types';

export class MyProviderAdapter implements StorageAdapter {
  async execute(input: StorageInput): Promise<StorageResult> {
    switch (input.operation) {
      case 'read':   return this.read(input);
      case 'write':  return this.write(input);
      case 'update': return this.update(input);
      case 'query':  return this.query(input);
      default:
        return { ok: false, reason: 'unknown_operation', error: `Unsupported: ${input.operation as string}` };
    }
  }
  // ... implement methods
}
```

2. Register in `modules/storage/src/index.ts`:
```typescript
import { MyProviderAdapter } from './adapters/my-provider';
registerAdapter('my-provider', new MyProviderAdapter());
```

3. Use in a flow step: `{ provider: 'my-provider', operation: 'read', resource: 'target', ... }`

---

## How to Add a New Communication Adapter

1. Create `modules/communication/src/my-channel.ts` implementing `CommunicationAdapter`:

```typescript
import type { CommunicationAdapter } from './types';

export class MyChannelAdapter implements CommunicationAdapter {
  async send(to: string, message: string): Promise<void> {
    if (!to) throw new Error('Missing recipient');
    if (!message) throw new Error('Missing message body');
    // call external API — throw on failure
  }
}
```

2. Register in `modules/communication/src/main.ts`:
```typescript
import { MyChannelAdapter } from './my-channel';
registerAdapter('my-channel', new MyChannelAdapter());
```

3. Use: `{ provider: 'my-channel', to: 'recipient-id', message: 'text' }` in step input,
   or set `COMM_PROVIDER=my-channel` for it to be the default.

---

## How to Add a New Intelligence Adapter

1. Create `modules/intelligence/src/adapters/my-llm.ts` implementing `AIAdapter`:

```typescript
import type { AIAdapter, Prompt } from '../types';

export class MyLLMAdapter implements AIAdapter {
  constructor(private readonly apiKey: string) {}

  async execute(prompt: Prompt, options?: any): Promise<string> {
    // Must return raw string. Pipeline will extract JSON from it.
    // Throw on failure.
    const response = await callMyAPI(this.apiKey, prompt.system, prompt.user);
    return response.text;
  }
}
```

2. Register in `modules/intelligence/src/index.ts`:
```typescript
import { MyLLMAdapter } from './adapters/my-llm';
registerAdapter('my-llm', new MyLLMAdapter(process.env.MY_LLM_API_KEY ?? ''));
```

3. Use: `{ provider: 'my-llm', task: 'classification', input: { text: '...' } }` in step input.

---

## How to Add a New Intelligence Task

1. Create `modules/intelligence/src/tasks/my-task.ts` implementing `TaskHandler`:

```typescript
import type { AIInput, Prompt, TaskHandler, TaskValidationResult } from '../types';

export class MyTaskHandler implements TaskHandler {
  buildPrompt(input: AIInput): Prompt {
    return {
      system: `Your system prompt here. Respond with JSON: {"result": "<value>"}`,
      user: input.input.text ?? '',
    };
  }

  validate(parsed: Record<string, unknown>, _input: AIInput): TaskValidationResult {
    if (typeof parsed.result !== 'string' || !parsed.result)
      return { valid: false, error: 'Missing field: result' };
    return { valid: true, output: { result: parsed.result } };
  }
}
```

2. Register in `modules/intelligence/src/index.ts`:
```typescript
import { MyTaskHandler } from './tasks/my-task';
registerTask('my-task', new MyTaskHandler());
```

3. Use: `{ provider: 'openai', task: 'my-task', input: { text: '...' } }` in step input.

---

## How to Add a New Ingestion Adapter

1. Create `modules/ingestion/src/adapters/my-adapter.ts` implementing `Adapter`:

```typescript
import type { Adapter, IngestionInput, IngestionResult } from '../types';

export class MyAdapter implements Adapter {
  async execute(input: IngestionInput): Promise<IngestionResult> {
    // normalize input.payload → NormalizedEvent
    // never throw — return typed result variants
    return {
      ok: true,
      event: {
        source: input.source,
        provider: input.provider,
        userId: '+1234567890',
        message: 'text from payload',
        raw: input.payload,
        timestamp: Date.now(),
      },
    };
  }
}
```

2. Register in `modules/ingestion/src/index.ts`:
```typescript
import { MyAdapter } from './adapters/my-adapter';
registerAdapter('my-source', 'my-provider', new MyAdapter());
```

3. Call: `receive({ source: 'my-source', provider: 'my-provider', payload: req.body })`

---

## How to Add a New Module Type

The engine currently supports three step types: `'intelligence'`, `'storage'`, `'communication'` (defined in `modules/engine/src/types.ts`). To add a fourth:

1. **Update engine types** (`modules/engine/src/types.ts`):
```typescript
export type Modules = Partial<Record<'intelligence' | 'storage' | 'communication' | 'notification', ModuleExecutor>>;
// and:
type FlowStep = {
  type: 'intelligence' | 'storage' | 'communication' | 'notification';
  ...
};
```

2. **Create the new module** following the standard contract (never throw, return `ModuleResult<T>`).

3. **Wire in the app**:
```typescript
const modules: Modules = {
  storage: ...,
  communication: ...,
  intelligence: ...,
  notification: (input) => notificationExecute(input as NotificationInput),
};
```

---

## Best Practices

| Practice | Reason |
|---|---|
| Never throw from `step.input()` | A throw will be caught by `executeStep` and mark the step as `failed`, stopping the flow |
| Always use `ctx.outputs?.['step-id']` with optional chaining | `outputs` is undefined until the first step writes to it |
| Cast `ctx.outputs` values to the expected type explicitly | Values are `unknown` — TypeScript won't warn without a cast |
| Keep `buildInitialContext()` synchronous | It runs before the engine; async validation belongs inside a flow step |
| Do not share state between flow invocations | `ExecutionContext` is per-invocation; there is no global flow state |
| Register adapters at module init, not at call time | Registration happens once when the module is imported |
| Return `{ ok: false, error, reason }` from adapter `execute()` rather than throwing | Throwing is acceptable in adapters since the module layer catches it, but explicit returns are cleaner |
