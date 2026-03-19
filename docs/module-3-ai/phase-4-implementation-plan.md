# Phase 4 — Implementation Plan
## AI Analysis Module (v1)

---

## 1. Folder Structure

```
ai-module/
├── src/
│   ├── main.ts           # Entry point — exports public analyze() function
│   ├── config.ts         # Env loading and validation
│   ├── handler.ts        # Pipeline orchestration
│   ├── validator.ts      # Input validation
│   ├── promptBuilder.ts  # System + user prompt construction
│   ├── llmClient.ts      # LLM API call (provider-agnostic)
│   ├── parser.ts         # JSON extraction and parsing
│   ├── postValidator.ts  # Output contract validation
│   └── logger.ts         # Structured JSON logging
├── tests/
│   ├── validator.test.ts
│   ├── promptBuilder.test.ts
│   ├── parser.test.ts
│   ├── postValidator.test.ts
│   ├── llmClient.test.ts
│   └── handler.test.ts
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

---

## 2. File Responsibilities

| File | Responsibility |
|------|----------------|
| `main.ts` | Exports `analyze()` as the single public function. Wires handler with config. No HTTP server. |
| `config.ts` | Loads env vars via dotenv. Validates required fields. Exports frozen `Config` object. Fails fast if required vars are missing. |
| `handler.ts` | Orchestrates the full pipeline: validator → promptBuilder → llmClient → parser → postValidator → logger. Catches all errors and returns standardized response. |
| `validator.ts` | Validates input shape and constraints (Phase 2 rules 1–6). Returns `{ valid: true }` or `{ valid: false, error }`. Pure function. |
| `promptBuilder.ts` | Constructs system and user prompt from validated input. Serializes data as compact JSON. Returns `{ system: string, user: string }`. Pure function. |
| `llmClient.ts` | Calls LLM API with configured timeout. Returns `{ success: true, rawResponse: string }` or `{ success: false, error }`. Provider-agnostic. Max 1 retry on network failure. |
| `parser.ts` | Applies three-stage JSON extraction strategy (fence → substring → direct). Returns `{ success: true, parsed: object }` or `{ success: false, error }`. Pure function. |
| `postValidator.ts` | Applies Phase 2 output validation rules 7–13. Checks fields, enums, row matching, contradiction. Returns `{ valid: true, result }` or `{ valid: false, error }`. Pure function. |
| `logger.ts` | Emits one structured JSON log per request to stdout. Accepts `{ status, errorCode?, latencyMs }`. No data, question, or answer logged. |

---

## 3. Function-Level Design

### main.ts
- `analyze(input)` → delegates to `handler.handle(input)`
- Calls `setup()` on module load: loads config, sets log level
- Exports only `analyze` — no other symbols exposed

### config.ts
- `loadConfig()` → reads `process.env`, validates required fields, returns frozen `Config`
- `Config` interface: `{ llmApiKey: string, llmProvider: string, llmTimeoutMs: number, logLevel: string }`
- `resetConfig()` → clears cached config (for test isolation)

### handler.ts
- `handle(input)` → runs full pipeline in order, catches all errors, returns final response
- Internal flow:
  1. `validator.validateInput(input)` → fail: return `INVALID_INPUT`
  2. `promptBuilder.buildPrompt(input)` → returns `{ system, user }`
  3. `llmClient.callLLM(prompt)` → fail: return `LLM_ERROR`
  4. `parser.parse(rawResponse)` → fail: return `LLM_ERROR`
  5. `postValidator.validate(parsed, input.data)` → fail: return mapped error
  6. `logger.log(...)` → always called
  7. Return success or failure envelope

### validator.ts
- `validateInput(input)` → checks all Phase 2 input rules (rules 1–6); returns `ValidationResult`
- Checks: `data` present and array, length ≤ 1000, uniform element shape, `question` non-empty, `context` constraints
- `ValidationResult` type: `{ valid: true }` or `{ valid: false, error: ErrorObject }`

### promptBuilder.ts
- `buildPrompt(input)` → constructs and returns `{ system: string, user: string }`
- `buildSystemPrompt()` → returns fixed system prompt string with schema and rules
- `buildUserPrompt(data, question, context?)` → serializes data as compact JSON, injects question and optional context
- No token counting or truncation in v1

### llmClient.ts
- `callLLM(prompt, config)` → sends API request, returns `{ success: true, rawResponse }` or `{ success: false, error }`
- `buildRequest(prompt, config)` → constructs provider-specific request body from prompt + config
- Timeout: `AbortController` with `config.llmTimeoutMs`
- Retry: max 1 retry on network-level error only; no retry on non-200 or bad response
- `resetClient()` → for test isolation (clears any internal state)

### parser.ts
- `parse(rawResponse)` → runs three-stage extraction, returns `{ success: true, parsed }` or `{ success: false, error }`
- `extractFromFences(raw)` → extracts content between triple-backtick markdown fences; returns `string | null`
- `extractFromSubstring(raw)` → finds first `{` and last `}`, extracts substring; returns `string | null`
- `tryParse(candidate)` → attempts `JSON.parse`; returns parsed object or `null`

### postValidator.ts
- `validate(parsed, inputData)` → applies Phase 2 output rules 7–13; returns `{ valid: true, result }` or `{ valid: false, error }`
- `checkRequiredFields(parsed)` → verifies `answer`, `rows`, `confidence`, `status` are all present
- `checkEnums(parsed)` → verifies `confidence` and `status` are valid enum values
- `matchRows(parsedRows, inputData)` → value-based equality check for each returned row against input; returns `boolean`
- `checkContradiction(answer, rows)` → detects direct value conflicts between `answer` text and `rows` values
- `mapStatus(status)` → converts LLM `status` field to module error code or success

### logger.ts
- `log(entry)` → accepts `{ status, errorCode?, latencyMs }`, emits JSON to stdout
- `setLogLevel(level)` → sets active log level; `"silent"` suppresses all; `"error"` suppresses success logs

---

## 4. Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | yes | — | API key for the configured LLM provider |
| `LLM_PROVIDER` | no | `"anthropic"` | LLM provider identifier (`"anthropic"` or `"openai"`) |
| `LLM_TIMEOUT_MS` | no | `10000` | LLM call timeout in milliseconds |
| `LOG_LEVEL` | no | `"info"` | Log verbosity: `"info"`, `"error"`, `"silent"` |

---

## 5. Dependencies

### Runtime

```json
{
  "dotenv": "latest"
}
```

No HTTP client library — use Node.js built-in `fetch` (Node 18+) with `AbortController` for timeout.

### Dev

```json
{
  "typescript": "latest",
  "jest": "latest",
  "ts-jest": "latest",
  "@types/node": "latest",
  "@types/jest": "latest",
  "tsx": "latest"
}
```

No additional packages. No LLM SDK — raw HTTP calls via `fetch`.

---

## 6. Test Strategy

| Test File | Approach | Coverage |
|-----------|----------|----------|
| `validator.test.ts` | Pure function tests — no mocks | Missing fields, wrong types, empty data, oversized data, whitespace question, context edge cases |
| `promptBuilder.test.ts` | Snapshot tests + content assertions | System prompt includes schema, user prompt includes question and data, context injection when present/absent |
| `parser.test.ts` | Edge case tests — pure function | Valid JSON, fenced JSON, text-wrapped JSON, malformed JSON, empty string, partial JSON, multi-object response |
| `postValidator.test.ts` | Strict rule tests — pure function | All 8 validation steps; row matching for objects and arrays; contradiction detection; status mapping |
| `llmClient.test.ts` | Mocked `fetch` | Success response, timeout → `LLM_ERROR`, network error + retry once + fail → `LLM_ERROR`, non-200 → `LLM_ERROR` |
| `handler.test.ts` | Integration with mocked modules | Full success flow, failure at each pipeline stage, correct error propagation, logger called once per request |

### Mock Strategy

- `llmClient.ts` — mock `fetch` via `jest.mock` or `global.fetch` override
- `handler.test.ts` — mock `llmClient`, `logger`; use real `validator`, `promptBuilder`, `parser`, `postValidator`
- All other test files — pure functions, no mocks needed

---

## 7. package.json Scripts

```json
{
  "scripts": {
    "dev": "tsx src/main.ts",
    "build": "tsc",
    "test": "jest"
  }
}
```

---

## 8. tsconfig.json Settings

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 9. .env.example

```
LLM_API_KEY=your-api-key-here
LLM_PROVIDER=anthropic
LLM_TIMEOUT_MS=10000
LOG_LEVEL=info
```

---

## 10. Implementation Rules

| Rule | Definition |
|------|------------|
| No classes | Functional style throughout — exported functions only |
| No async side effects | Side effects (logging, API calls) confined to handler and llmClient |
| No retries beyond defined | Max 1 retry in llmClient, network-level only |
| No data logging | Input data, question, and answer are never written to logs |
| Strict typing | TypeScript strict mode; no `any` except at API boundary |
| Pure functions | validator, promptBuilder, parser, postValidator have zero side effects |
| Single public export | `main.ts` exports only `analyze()` |

---

## Status

Phase 4 complete. Awaiting approval for Phase 5: Implementation.
