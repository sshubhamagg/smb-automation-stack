# Adapters

Adapters are the concrete provider implementations inside each module. They are the only layer that calls external APIs.

---

## Pattern

Every module uses the same three-file adapter pattern:

**1. Interface** (`types.ts`) — defines what an adapter must implement:

```typescript
// Example: modules/storage/src/types.ts
interface StorageAdapter {
  execute(input: StorageInput): Promise<StorageResult>;
}
```

**2. Registry** (`registry.ts`) — a `Map<string, Adapter>` with two functions:

```typescript
// Example: modules/storage/src/registry.ts
const registry = new Map<string, StorageAdapter>();

export function registerAdapter(provider: string, adapter: StorageAdapter): void {
  registry.set(provider, adapter);
}

export function getAdapter(provider: string): StorageAdapter {
  const adapter = registry.get(provider);
  if (!adapter) throw new Error(`No storage adapter registered for provider: ${provider}`);
  return adapter;
}
```

**3. Registration** (`index.ts`) — called at module initialization:

```typescript
// modules/storage/src/index.ts
registerAdapter('sheets',   new SheetsAdapter());
registerAdapter('postgres', new PostgresAdapter());
```

Registration happens exactly once, at process start, when the module is first imported.

---

## Adapter Interfaces

| Module | Interface | Method signature |
|---|---|---|
| `ingestion-module` | `Adapter` | `execute(input: IngestionInput): Promise<IngestionResult>` |
| `storage-module` | `StorageAdapter` | `execute(input: StorageInput): Promise<StorageResult>` |
| `communication-module` | `CommunicationAdapter` | `send(to: string, message: string): Promise<void>` |
| `intelligence-module` | `AIAdapter` | `execute(prompt: Prompt, options?: any): Promise<string>` |

---

## All Registered Adapters

### ingestion-module

| Key (`source:provider`) | Class | File |
|---|---|---|
| `'whatsapp:meta'` | `MetaAdapter` | `modules/ingestion/src/adapters/meta.ts` |

Registry lookup: `getAdapter(input.source, input.provider)` — key is `"${source}:${provider}"`.

### storage-module

| Key (`provider`) | Class | File |
|---|---|---|
| `'sheets'` | `SheetsAdapter` | `modules/storage/src/adapters/sheets.ts` |
| `'postgres'` | `PostgresAdapter` | `modules/storage/src/adapters/postgres.ts` |

### communication-module

| Key (`provider`) | Class | File |
|---|---|---|
| `'meta'` | `MetaAdapter` | `modules/communication/src/meta.ts` |
| `'twilio'` | `TwilioAdapter` | `modules/communication/src/twilio.ts` |
| `'telegram'` | `TelegramAdapter` | `modules/communication/src/telegram.ts` |

### intelligence-module (adapters)

| Key (`provider`) | Class | Default model | File |
|---|---|---|---|
| `'openai'` | `OpenAIAdapter` | `gpt-4o-mini` | `src/adapters/openai.ts` |
| `'anthropic'` | `AnthropicAdapter` | `claude-haiku-4-5-20251001` | `src/adapters/anthropic.ts` |
| `'local'` | `LocalAIAdapter` | `deepseek-r1` (Ollama) | `src/adapters/local.ts` |
| `'nvidia'` | `NvidiaAdapter` | `meta/llama-3.1-8b-instruct` | `src/adapters/nvidia.ts` |

### intelligence-module (tasks — second registry)

The intelligence module maintains a separate `Map<string, TaskHandler>` registry alongside the adapter registry.

| Key (`task`) | Class | File |
|---|---|---|
| `'classification'` | `ClassificationHandler` | `modules/intelligence/src/tasks/classification.ts` |
| `'extraction'` | `ExtractionHandler` | `modules/intelligence/src/tasks/extraction.ts` |
| `'qa'` | `QAHandler` | `modules/intelligence/src/tasks/qa.ts` |
| `'reasoning'` | `ReasoningHandler` | `modules/intelligence/src/tasks/reasoning.ts` |

---

## How to Add a New Adapter

### Storage adapter example

**Step 1** — Create the adapter class:

```typescript
// modules/storage/src/adapters/my-db.ts
import type { StorageAdapter, StorageInput, StorageResult } from '../types';

export class MyDbAdapter implements StorageAdapter {
  async execute(input: StorageInput): Promise<StorageResult> {
    switch (input.operation) {
      case 'read':   return this.read(input);
      case 'write':  return this.write(input);
      case 'update': return this.update(input);
      default:
        return { ok: false, reason: 'unknown_operation', error: `Unsupported: ${input.operation as string}` };
    }
  }
  // ... implement read, write, update
}
```

**Step 2** — Register in `modules/storage/src/index.ts`:

```typescript
import { MyDbAdapter } from './adapters/my-db';
registerAdapter('my-db', new MyDbAdapter());
```

**Step 3** — Use in a flow step:

```typescript
{
  id: 'store-data',
  type: 'storage',
  input: () => ({
    provider: 'my-db',
    operation: 'write',
    resource: 'my_table',
    data: { col1: 'value' },
  }),
}
```

No engine or flow changes required. Only add the class and the `registerAdapter()` call.

---

### Communication adapter example

```typescript
// modules/communication/src/my-channel.ts
import type { CommunicationAdapter } from './types';

export class MyChannelAdapter implements CommunicationAdapter {
  async send(to: string, message: string): Promise<void> {
    if (!to) throw new Error('Missing recipient');
    // ... call external API
  }
}
```

Register in `modules/communication/src/main.ts`:

```typescript
import { MyChannelAdapter } from './my-channel';
registerAdapter('my-channel', new MyChannelAdapter());
```

Use with `provider: 'my-channel'` in step input or `COMM_PROVIDER=my-channel` env var.

---

### Intelligence adapter example

```typescript
// modules/intelligence/src/adapters/my-llm.ts
import type { AIAdapter, Prompt } from '../types';

export class MyLLMAdapter implements AIAdapter {
  async execute(prompt: Prompt, options?: any): Promise<string> {
    // Must return raw text string that the pipeline will parse as JSON
    // Throw on failure — pipeline catches this and returns { ok: false, reason: 'provider_error' }
    const response = await callMyLLMAPI(prompt.system, prompt.user);
    return response.text;
  }
}
```

Register in `modules/intelligence/src/index.ts`:

```typescript
import { MyLLMAdapter } from './adapters/my-llm';
registerAdapter('my-llm', new MyLLMAdapter(process.env.MY_LLM_API_KEY ?? ''));
```

---

### Intelligence task example

```typescript
// modules/intelligence/src/tasks/summarization.ts
import type { AIInput, Prompt, TaskHandler, TaskValidationResult } from '../types';

export class SummarizationHandler implements TaskHandler {
  buildPrompt(input: AIInput): Prompt {
    return {
      system: 'Summarize the content. Respond with: {"summary": "<text>", "wordCount": <number>}',
      user: input.input.text ?? '',
    };
  }

  validate(parsed: Record<string, unknown>): TaskValidationResult {
    if (typeof parsed.summary !== 'string' || !parsed.summary)
      return { valid: false, error: 'Missing field: summary' };
    return { valid: true, output: { summary: parsed.summary, wordCount: parsed.wordCount } };
  }
}
```

Register in `modules/intelligence/src/index.ts`:

```typescript
import { SummarizationHandler } from './tasks/summarization';
registerTask('summarization', new SummarizationHandler());
```

---

## Ingestion adapter

The ingestion registry uses a compound key `"source:provider"`:

```typescript
// modules/ingestion/src/registry.ts
registerAdapter(source: string, provider: string, adapter: Adapter): void
// key = `${source}:${provider}`
```

New ingestion adapter:

```typescript
// modules/ingestion/src/adapters/sms-twilio.ts
import type { Adapter, IngestionInput, IngestionResult } from '../types';

export class TwilioSMSAdapter implements Adapter {
  async execute(input: IngestionInput): Promise<IngestionResult> {
    // normalize Twilio SMS webhook payload → NormalizedEvent
  }
}
```

Register in `modules/ingestion/src/index.ts`:

```typescript
registerAdapter('sms', 'twilio', new TwilioSMSAdapter());
```

Call with `receive({ source: 'sms', provider: 'twilio', payload: req.body })`.
