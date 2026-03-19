# Phase 1 — Module Definition
## AI Analysis Module (v1)

---

## 1. Purpose

Accept structured tabular data and a natural language question, send both to an LLM, and return a structured response containing a human-readable answer and the specific rows from the input data that support that answer. The module makes no assumptions about the data schema, performs no data retrieval, and holds no state between calls. LLM outputs are probabilistic — identical inputs may produce slightly different answers across calls. The module is designed for consistent behavior, but determinism is not guaranteed.

---

## 2. Responsibilities

| # | Responsibility |
|---|----------------|
| 1 | Accept structured data as an array of objects or array of arrays |
| 2 | Accept a natural language question about that data |
| 3 | Accept optional context (description, column names) to aid interpretation |
| 4 | Send data and question to an LLM for analysis |
| 5 | Return the answer in human-readable form |
| 6 | Return the specific rows from the input data used to support the answer |
| 7 | Return a confidence level (`low`, `medium`, `high`) |
| 8 | Handle ambiguous questions gracefully — return a structured failure instead of guessing |
| 9 | Handle insufficient data gracefully — return a structured failure instead of hallucinating |

---

## 3. Boundaries — What This Module Does NOT Do

- Does NOT store or retrieve data
- Does NOT call any external system except the LLM API
- Does NOT maintain memory, session, or state between calls
- Does NOT execute workflows or multi-step plans
- Does NOT perform multi-step planning or agentic behavior
- Does NOT semantically transform, enrich, or interpret input data before passing to LLM
- MAY apply minimal structural handling (enforcing row limits, normalizing array shape) before passing to LLM
- Does NOT assume schema, column meanings, or data types
- Does NOT validate business rules or domain logic
- Does NOT produce answers beyond what the provided data supports

---

## 4. Input Structure

```json
{
  "data": [...],
  "question": "string",
  "context": {
    "description": "string",
    "columns": ["string", "string", "..."]
  }
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `data` | array | yes | The tabular data to analyze. Array of objects or array of arrays. |
| `question` | string | yes | Natural language question about the data. Must be non-empty. |
| `context.description` | string | no | Optional description of what the data represents. |
| `context.columns` | array of strings | no | Optional column names. Required when `data` is array of arrays without headers. |

### Data Shape Rules

- `data` may be an array of objects: `[ { "col": "val" }, ... ]`
- `data` may be an array of arrays: `[ ["val1", "val2"], ... ]`
- All cell values are strings — the module must not assume types
- `data` must be non-empty (at least one row)
- Maximum supported size: ~1000 rows (v1)
- If `data` exceeds 1000 rows, the module returns `INVALID_INPUT` — truncation is not performed
- The module does not infer column meanings — context is caller's responsibility

---

## 5. Output Structure

### Success

```json
{
  "success": true,
  "data": {
    "answer": "string",
    "rows": [...],
    "confidence": "low | medium | high"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `data.answer` | string | Human-readable answer to the question |
| `data.rows` | array | Subset of input rows that directly support the answer. May be empty if no specific rows apply. |
| `data.confidence` | string | Heuristic-based confidence derived from the LLM response: `"low"`, `"medium"`, or `"high"`. Not purely LLM-reported — the module applies rules to determine the final value. |

### Failure

```json
{
  "success": false,
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

---

## 6. Error Cases

| Code | Trigger |
|------|---------|
| `INVALID_INPUT` | Missing or malformed required field (`data`, `question`); data is empty; question is empty string |
| `INSUFFICIENT_DATA` | The provided data does not contain enough information to answer the question |
| `AMBIGUOUS_QUESTION` | The question cannot be answered with a single interpretation of the data |
| `LLM_ERROR` | The LLM API returned an error, timed out, or returned a response that cannot be parsed into the expected output structure |

---

## 7. Behavior Rules

- Answer MUST be based only on the provided `data` — no external knowledge applied to fill gaps
- LLM MUST NOT hallucinate values not present in the data
- The module MUST NOT assume units, currency, meaning, or type of any column
- Supporting `rows` MUST come from the input data verbatim — no derived or computed rows
- If the question is ambiguous and cannot be answered reliably → return `AMBIGUOUS_QUESTION`
- If data is present but insufficient to answer → return `INSUFFICIENT_DATA`
- Confidence `"low"` signals the answer may be unreliable — caller should treat with caution
- Confidence `"high"` requires the LLM to have found clear, unambiguous evidence in the data
- LLM output MUST be machine-parseable into the defined output structure — if parsing fails, return `LLM_ERROR`
- The LLM may interpret numeric strings (e.g. `"50"` as 50) for comparison and aggregation — the module does not enforce or validate types
- Answers SHOULD include concise reasoning tied to specific rows — not just a bare conclusion

---

## 8. Example Scenarios

---

### Scenario 1 — Lowest Value

**Input:**
```json
{
  "data": [
    { "product": "cement", "stock": "50" },
    { "product": "steel", "stock": "20" },
    { "product": "sand", "stock": "80" }
  ],
  "question": "Which product has the lowest stock?"
}
```

**Expected Output:**
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

---

### Scenario 2 — Filtering Condition

**Input:**
```json
{
  "data": [
    { "product": "cement", "stock": "50", "status": "active" },
    { "product": "steel", "stock": "20", "status": "inactive" },
    { "product": "sand", "stock": "80", "status": "active" }
  ],
  "question": "Which active products have stock above 40?"
}
```

**Expected Output:**
```json
{
  "success": true,
  "data": {
    "answer": "Cement is the only active product with stock above 40 (stock: 50).",
    "rows": [{ "product": "cement", "stock": "50", "status": "active" }],
    "confidence": "high"
  }
}
```

---

### Scenario 3 — Aggregation

**Input:**
```json
{
  "data": [
    { "product": "cement", "stock": "50" },
    { "product": "steel", "stock": "20" },
    { "product": "sand", "stock": "80" }
  ],
  "question": "What is the total stock across all products?"
}
```

**Expected Output:**
```json
{
  "success": true,
  "data": {
    "answer": "The total stock across all products is 150.",
    "rows": [
      { "product": "cement", "stock": "50" },
      { "product": "steel", "stock": "20" },
      { "product": "sand", "stock": "80" }
    ],
    "confidence": "high"
  }
}
```

---

### Scenario 4 — No Matching Data

**Input:**
```json
{
  "data": [
    { "product": "cement", "stock": "50" },
    { "product": "steel", "stock": "20" }
  ],
  "question": "Which products are out of stock?"
}
```

**Expected Output:**
```json
{
  "success": true,
  "data": {
    "answer": "No products in the provided data are out of stock. All listed products have stock values greater than zero.",
    "rows": [],
    "confidence": "high"
  }
}
```

---

### Scenario 5 — Ambiguous Question

**Input:**
```json
{
  "data": [
    { "product": "cement", "value": "50" },
    { "product": "steel", "value": "20" }
  ],
  "question": "Which is better?"
}
```

**Expected Output:**
```json
{
  "success": false,
  "error": {
    "code": "AMBIGUOUS_QUESTION",
    "message": "The question 'Which is better?' cannot be answered from the data. No criteria for 'better' is defined.",
    "details": {}
  }
}
```

---

## Status

Phase 1 complete. Awaiting approval for Phase 2: Contract Design.
