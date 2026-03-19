# Phase 3 — Technical Design
## AI Analysis Module (v1)

---

## 1. Internal Architecture

Single-process, single-call pipeline. No agents, no memory, no concurrency control.

```
┌──────────────────────────────────────────────────────────────┐
│                         Handler                              │
│              (entry point — orchestrates pipeline)           │
└───────────────────────┬──────────────────────────────────────┘
                        │
             ┌──────────▼──────────┐
             │      Validator       │
             │   (input only)       │
             └──────────┬───────────┘
                        │
             ┌──────────▼──────────┐
             │    Prompt Builder    │
             │  (system + user)     │
             └──────────┬───────────┘
                        │
             ┌──────────▼──────────┐
             │     LLM Client       │
             │  (single API call)   │
             └──────────┬───────────┘
                        │
             ┌──────────▼──────────┐
             │       Parser         │
             │  (JSON extraction)   │
             └──────────┬───────────┘
                        │
             ┌──────────▼──────────┐
             │   Post-Validator     │
             │  (output contract)   │
             └──────────┬───────────┘
                        │
             ┌──────────▼──────────┐
             │       Logger         │
             │   (shared, passive)  │
             └──────────────────────┘
```

---

## 2. Component Responsibilities

### Handler
- Receives operation input: `{ data, question, context? }`
- Calls each pipeline stage in order
- Catches all errors and maps to final error response
- Calls Logger once per request on success and on failure
- Never exposes internal fields (e.g. `headerValid`, raw LLM response) in output

### Validator
- Validates input structure before any LLM call
- Checks all rules defined in Phase 2 §8 input validation (rules 1–6)
- Returns `{ valid: true }` or `{ valid: false, error: INVALID_INPUT }`
- Pure function — no side effects

### Prompt Builder
- Constructs system prompt and user prompt from validated input
- Serializes `data` as JSON string for inclusion in prompt
- Includes `context.description` and `context.columns` if provided
- Returns a prompt object: `{ system: string, user: string }`
- Pure function — no side effects

### LLM Client
- Accepts prompt object, calls LLM API with configured timeout
- Returns `{ success: true, rawResponse: string }` or `{ success: false, error }`
- Does not parse or interpret the response — raw string only
- Handles timeout as `LLM_ERROR`
- v1: max 1 retry on network-level failure only (not on bad LLM output)

### Parser
- Accepts raw LLM response string
- Applies a three-stage extraction strategy to locate valid JSON even when surrounded by text
- Attempts `JSON.parse` on extracted content
- Returns `{ success: true, parsed: object }` or `{ success: false, error: LLM_ERROR }`
- If extraction fails or parse fails → `LLM_ERROR`

### Post-Validator
- Applies all Phase 2 §8 output validation rules (rules 7–13)
- Checks required fields, enum values, row matching, answer–row consistency
- Row matching uses value-based equality (key order ignored for objects)
- Returns `{ valid: true, result }` or `{ valid: false, error: LLM_ERROR }`
- Pure function — no side effects

### Logger
- Called once per request by Handler
- Emits structured JSON to stdout
- Never logs input data or question content (privacy)
- Passive — does not affect pipeline execution

---

## 3. Data Flow

Full pipeline step-by-step.

```
INPUT: { data, question, context? }
  │
  ▼
[1] VALIDATE INPUT
    → Validator checks structure, types, constraints
    → Fail: return INVALID_INPUT immediately (LLM never called)
  │
  ▼
[2] NORMALIZE DATA
    → If data is array of arrays + context.columns provided:
        map to array of objects using column names as keys
    → If data is array of arrays with no columns: pass as-is
    → No semantic transformation — structure only
  │
  ▼
[3] BUILD PROMPT
    → Prompt Builder constructs system + user prompt
    → Serializes normalized data as JSON
    → Injects question and optional context
  │
  ▼
[4] CALL LLM
    → LLM Client sends prompt, waits for response
    → Timeout → LLM_ERROR
    → Network failure → retry once → LLM_ERROR if still fails
  │
  ▼
[5] PARSE RESPONSE
    → Parser strips markdown fences if present
    → JSON.parse on extracted content
    → Parse failure → LLM_ERROR
  │
  ▼
[6] VALIDATE OUTPUT
    → Post-Validator applies rules 7–13
    → Missing fields, bad enums, rows not in input, contradiction → LLM_ERROR
    → status === "insufficient_data" → INSUFFICIENT_DATA
    → status === "ambiguous" → AMBIGUOUS_QUESTION
  │
  ▼
[7] MAP TO RESPONSE
    → status === "ok": return success envelope with answer, rows, confidence
    → any error: return failure envelope with code, message, details
  │
  ▼
OUTPUT: { success, data } OR { success, error }
```

---

## 4. Prompt Design

### System Prompt

```
You are a data analysis assistant. You will be given structured tabular data
and a question about that data.

Your task:
- Analyze the data to answer the question
- Base your answer ONLY on the provided data — do not use external knowledge
- Do not hallucinate values not present in the data
- Return your response as a single JSON object with no surrounding text

Required JSON schema:
{
  "answer": "string — your answer in plain language",
  "rows": [...] — array of rows from the input data that support your answer,
  "confidence": "low | medium | high",
  "status": "ok | insufficient_data | ambiguous"
}

Rules:
- Return ONLY the JSON object — no preamble, no explanation, no markdown fences
- "rows" must contain only rows copied exactly from the input data
- If the question cannot be answered: set status to "insufficient_data" or "ambiguous"
- If status is not "ok": set answer to empty string and rows to []
- "confidence" must be exactly one of: "low", "medium", "high"
- "status" must be exactly one of: "ok", "insufficient_data", "ambiguous"
```

### User Prompt Structure

```
Data:
<serialized JSON of input data>

Context:
<context.description if provided, else omitted>
Columns: <context.columns if provided, else omitted>

Question:
<question>
```

### Prompt Rules

| Rule | Definition |
|------|------------|
| Data serialization | Input data serialized as compact JSON — no pretty-printing |
| Context injection | `context.description` and `context.columns` included only if provided by caller |
| Schema in prompt | Full output schema is always included in system prompt |
| Strictness | System prompt explicitly forbids text outside JSON object |
| Prompt ownership | Prompt Builder owns the full prompt — no dynamic schema generation |
| Token awareness | Prompt Builder does not truncate or summarize data in v1. The 1000-row input limit is the mechanism that keeps prompts within reasonable token bounds. Token budget management is deferred to a future version. |

---

## 5. LLM Client Design

### Interface

```
callLLM(prompt: { system: string, user: string })
  → { success: true, rawResponse: string }
  OR { success: false, error: { code: "LLM_ERROR", message: string } }
```

### Behavior

| Scenario | Action |
|----------|--------|
| Successful API response | Return `{ success: true, rawResponse }` |
| Timeout (configurable, default 10s) | Return `{ success: false, error: LLM_ERROR }` |
| Network-level error (connection refused, DNS failure) | Retry once → if still fails, return `{ success: false, error: LLM_ERROR }` |
| HTTP non-200 from LLM API | Return `{ success: false, error: LLM_ERROR }` — no retry |
| Retry policy | Max 1 retry, network-level only. No retry on bad output. |

### Constraints

- No response streaming (v1)
- Raw string returned — no parsing inside LLM Client
- Timeout clock starts when request is sent
- Provider-agnostic design: LLM Client abstracts the API provider. The caller configures the provider (e.g. Anthropic, OpenAI) via environment. The interface `callLLM(prompt)` does not change across providers.

---

## 6. Parser Design

### JSON Extraction Strategy

Three-stage extraction applied in order. First successful parse wins.

```
Stage 1 — Markdown fence extraction:
  Check if response contains a markdown code fence (``` or ```json)
  → If yes: extract content between opening and closing fences
  → Attempt JSON.parse on extracted content
  → If parse succeeds: return { success: true, parsed: object }

Stage 2 — Substring extraction:
  Find the index of the first '{' and the index of the last '}'
  → If both found: extract substring from first '{' to last '}'
  → Attempt JSON.parse on extracted substring
  → If parse succeeds: return { success: true, parsed: object }

Stage 3 — Direct parse:
  Attempt JSON.parse on the full raw response string as-is
  → If parse succeeds: return { success: true, parsed: object }

If all three stages fail:
  → Return { success: false, error: LLM_ERROR }
```

### Rules

- Parser does NOT validate schema — only extracts and parses JSON
- Extraction and parse failure at all three stages → `LLM_ERROR`
- Multi-object responses: only the first valid JSON object found is used
- Partial JSON (no closing `}`) → Stage 2 substring will not parse → falls through to Stage 3 → `LLM_ERROR`

---

## 7. Post-Validation

Applies Phase 2 validation rules 7–13 in order.

### Validation Steps

| Step | Rule | Failure |
|------|------|---------|
| 1 | All required fields present: `answer`, `rows`, `confidence`, `status` | `LLM_ERROR` |
| 2 | `status` is one of: `"ok"`, `"insufficient_data"`, `"ambiguous"` | `LLM_ERROR` |
| 3 | `confidence` is one of: `"low"`, `"medium"`, `"high"` | `LLM_ERROR` |
| 4 | Every row in `rows` matches an input row by value equality | `LLM_ERROR` |
| 5 | If `status === "ok"`: `answer` is non-empty string | `LLM_ERROR` |
| 6 | If `status === "ok"`: `answer` does not contradict values in `rows` | `LLM_ERROR` |
| 7 | If `status === "insufficient_data"`: map to `INSUFFICIENT_DATA` | Business error |
| 8 | If `status === "ambiguous"`: map to `AMBIGUOUS_QUESTION` | Business error |

### Row Matching Logic

**Object rows:**
```
For each row R in LLM-returned rows:
  Find any row I in input data where:
    every key in I exists in R with equal value
    AND every key in R exists in I (no extra keys in R)
  Key order is ignored — comparison is by key-value pairs only
  If no match found → LLM_ERROR
```

**Array rows:**
```
For each row R in LLM-returned rows:
  Find any row I in input data where:
    R.length === I.length
    AND every element R[i] === I[i]
  If no match found → LLM_ERROR
```

### Contradiction Check

- Contradiction detection in v1 is limited to direct value conflicts only — no semantic reasoning
- A direct value conflict is defined as: a value appearing in `rows` that is explicitly contradicted by the same value stated in `answer`
- Example: `answer` says "cement has stock 50" but `rows` contains `{ product: "cement", stock: "20" }` → `LLM_ERROR`
- Semantic contradictions (e.g. inferring incorrectness from domain knowledge) are out of scope for v1 — prompt design mitigates these

---

## 8. Error Handling Flow

```
Pipeline Stage         → Error Type        → Module Error Code
──────────────────────────────────────────────────────────────
Validator              → Validation fail   → INVALID_INPUT
LLM Client (timeout)   → Timeout           → LLM_ERROR
LLM Client (network)   → Network failure   → LLM_ERROR
LLM Client (non-200)   → API error         → LLM_ERROR
Parser                 → JSON extraction fail → LLM_ERROR
Parser                 → JSON parse fail     → LLM_ERROR
Post-Validator         → Schema fail       → LLM_ERROR
Post-Validator         → Row mismatch      → LLM_ERROR
Post-Validator         → Contradiction     → LLM_ERROR
Post-Validator (status)→ insufficient_data → INSUFFICIENT_DATA
Post-Validator (status)→ ambiguous         → AMBIGUOUS_QUESTION
Handler (unexpected)   → Unclassified      → LLM_ERROR
```

All errors are caught by Handler and returned in the standard failure envelope.
No errors propagate to the caller as uncaught exceptions.

---

## 9. Logging

One structured JSON log line per request. Emitted by Handler after pipeline completes.

### Log Schema

```json
{
  "operation": "analyze",
  "status": "success | error",
  "errorCode": "string | null",
  "latencyMs": number
}
```

### Logging Rules

| Rule | Definition |
|------|------------|
| One log per request | Always — success and failure |
| Input data | NEVER logged — privacy |
| Question | NEVER logged — privacy |
| Answer | NEVER logged — privacy |
| `errorCode` | Included on failure; `null` on success |
| `latencyMs` | Total pipeline duration in milliseconds — measured from the moment Handler receives the request to the moment the final response is returned |

---

## 10. Performance Constraints

| Constraint | Value |
|------------|-------|
| Max input rows | 1000 |
| Expected end-to-end latency | < 5 seconds (LLM-dependent) |
| LLM call timeout | 10 seconds (configurable) |
| Streaming | Not supported in v1 |
| Retries | Max 1, network-level only |

---

## 11. Simplifications (v1)

Explicitly out of scope:

| Feature | Status |
|---------|--------|
| Caching | Not implemented — every call hits LLM |
| Batching | Not implemented — one question per call |
| Streaming | Not implemented — full response required before parsing |
| Concurrency control | Not implemented — caller manages concurrency |
| Multi-step reasoning | Not implemented — single LLM call only |
| Session or memory | Not implemented — stateless by design |

---

## Status

Phase 3 complete. Awaiting approval for Phase 4: Implementation Plan.
