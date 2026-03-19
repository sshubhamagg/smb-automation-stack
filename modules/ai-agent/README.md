# AI Analysis Module

Standalone module. Accepts tabular data and a natural language question, calls an LLM, and returns a structured answer with supporting rows and confidence.

---

## Responsibilities

- Validate input (data array + question string)
- Build a structured prompt
- Call the configured LLM provider
- Parse and post-validate the LLM response
- Return a typed result envelope

Does **not** interpret business logic, store data, or perform multi-step reasoning.

---

## Usage

```typescript
import { analyze } from './src/main';

const result = await analyze({
  data: [
    { product: 'cement', stock: '50' },
    { product: 'steel', stock: '20' },
  ],
  question: 'Which product has the lowest stock?',
});

if (result.success) {
  console.log(result.data.answer);     // "Steel has the lowest stock with a value of 20."
  console.log(result.data.rows);       // [{ product: 'steel', stock: '20' }]
  console.log(result.data.confidence); // "high"
} else {
  console.error(result.error.code);    // "INVALID_INPUT" | "LLM_ERROR" | ...
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LLM_API_KEY` | yes | — | API key for the LLM provider |
| `LLM_PROVIDER` | no | `anthropic` | `anthropic` or `openai` |
| `LLM_TIMEOUT_MS` | no | `10000` | Request timeout in milliseconds |
| `LOG_LEVEL` | no | `info` | `silent`, `info`, or `debug` |

Copy `.env.example` to `.env` and fill in values.

---

## Response Envelope

**Success**
```json
{
  "success": true,
  "data": {
    "answer": "Steel has the lowest stock with a value of 20.",
    "rows": [{ "product": "steel", "stock": "20" }],
    "confidence": "high"
  }
}
```

**Failure**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "data is required and must be a non-empty array"
  }
}
```

### Error Codes

| Code | Cause |
|---|---|
| `INVALID_INPUT` | Missing/invalid `data` or `question` |
| `LLM_ERROR` | LLM call failed, timed out, or returned invalid/hallucinated response |
| `INSUFFICIENT_DATA` | LLM signalled the data does not contain enough information |
| `AMBIGUOUS_QUESTION` | LLM signalled the question is ambiguous |

---

## Input Constraints

- `data`: non-empty array, max 1000 rows
- `question`: non-empty string
- Rows must be uniform objects or uniform arrays (no mixed types)

---

## Architecture

```
handle()
  └── validateInput()
  └── buildPrompt()
  └── callLLM()
  └── parse()          ← 3-stage JSON extraction
  └── validate()       ← post-validates LLM response
  └── log()
```

### LLM Response Validation

The module validates that the LLM response:
1. Is valid JSON (not an array, not null)
2. Contains required fields: `answer`, `rows`, `confidence`, `status`
3. Uses valid enum values for `confidence` (`low`, `medium`, `high`) and `status` (`ok`, `insufficient_data`, `ambiguous`)
4. All returned rows exist in the input data (no hallucination)
5. Answer is non-empty when `status` is `ok`

### JSON Extraction (3 stages)

1. Markdown fences (` ```json … ``` `)
2. First `{` to last `}` substring
3. Direct parse

Top-level JSON arrays are rejected before extraction.

### Retry

One automatic retry on network error. No retry on HTTP 4xx/5xx or timeout.

---

## Running Tests

```bash
npm install
npm test
```

109 tests across 6 suites — all pass.

---

## File Structure

```
modules/ai-agent/
├── src/
│   ├── config.ts          # Load and cache env config
│   ├── logger.ts          # Structured log (no data/question/answer)
│   ├── validator.ts       # Input validation
│   ├── promptBuilder.ts   # System + user prompt construction
│   ├── llmClient.ts       # Provider-agnostic LLM fetch + retry
│   ├── parser.ts          # 3-stage JSON extraction
│   ├── postValidator.ts   # LLM response validation
│   ├── handler.ts         # Orchestration + latency tracking
│   └── main.ts            # Public entry point (analyze)
├── tests/
│   ├── validator.test.ts
│   ├── promptBuilder.test.ts
│   ├── parser.test.ts
│   ├── postValidator.test.ts
│   ├── llmClient.test.ts
│   └── handler.test.ts
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Limitations (v1)

- Contradiction detection (`checkContradiction`) always returns `false` — no NLP capability
- No streaming — single blocking LLM call per request
- No truncation — inputs over 1000 rows are rejected (`INVALID_INPUT`)
- No caching or deduplication of LLM calls
