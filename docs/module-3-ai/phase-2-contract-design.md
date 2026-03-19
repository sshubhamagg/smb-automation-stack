# Phase 2 — Contract Design
## AI Analysis Module (v1)

---

## 1. Standard Response Envelope

All responses follow a single top-level shape.

```json
{
  "success": true | false,
  "data": {},
  "error": {}
}
```

**Rules:**

| Rule | Definition |
|------|------------|
| `success: true` | `data` is present. `error` is omitted. |
| `success: false` | `error` is present. `data` is omitted. |
| `success` and `error` | Mutually exclusive — never both present |
| `success` | Always a boolean. Never null, never string. |

---

## 2. Input Contract

### Schema

```json
{
  "data": [...],
  "question": "string",
  "context": {
    "description": "string",
    "columns": ["string", "string"]
  }
}
```

### Field Definitions

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `data` | array | yes | Non-empty. Max 1000 elements. Each element is an object or an array. |
| `question` | string | yes | Non-empty. Not whitespace-only. |
| `context` | object | no | Optional wrapper. May be omitted entirely. |
| `context.description` | string | no | Non-empty if provided. Describes what the data represents. |
| `context.columns` | array of strings | no | Non-empty if provided. Each entry is a non-empty string. Required when `data` is array of arrays with no header row. |

### Validation Rules

| Field | Validation Failure → Error Code |
|-------|----------------------------------|
| `data` missing or not array | `INVALID_INPUT` |
| `data` is empty array | `INVALID_INPUT` |
| `data` has more than 1000 elements | `INVALID_INPUT` |
| `data` element is not object or array | `INVALID_INPUT` |
| `question` missing | `INVALID_INPUT` |
| `question` is empty or whitespace | `INVALID_INPUT` |
| `context.columns` provided but empty | `INVALID_INPUT` |
| `context.description` provided but empty | `INVALID_INPUT` |

### Data Value Constraints

- All cell values must be strings
- The module does not enforce types — numeric strings are passed as-is
- Mixed element types within `data` (some objects, some arrays) are not supported → `INVALID_INPUT`

---

## 3. Output Contract — Success

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

### Field Definitions

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `data.answer` | string | yes | Non-empty. Human-readable. Must not contradict supporting `rows`. |
| `data.rows` | array | yes | May be empty `[]`. Each element must match a row in the input `data` by value equality. Key order variation in objects is allowed. No derived or computed rows. |
| `data.confidence` | string | yes | Exactly one of: `"low"`, `"medium"`, `"high"`. No other values. |

### Confidence Semantics

| Value | Meaning |
|-------|---------|
| `"high"` | Clear, unambiguous evidence found in data. Answer is directly supported by rows. |
| `"medium"` | Answer is supported but involves interpretation (e.g. numeric comparison of string values). |
| `"low"` | Answer is a best-effort inference. Caller should treat result with caution. |

### Row Matching Rules

Row matching uses value-based equality, not reference equality.

**Object rows:**
- A returned row matches an input row if every key-value pair is equal
- Key order does not matter — `{ "stock": "20", "product": "steel" }` matches `{ "product": "steel", "stock": "20" }`
- All keys and values must be present and equal; extra keys in the returned row → no match

**Array rows:**
- A returned row matches an input row if all values are equal and in the same order
- `["steel", "20"]` matches `["steel", "20"]` — order is significant for arrays

### Invariants

- `rows` must match rows in the input `data` by value equality — no row may be synthesized
- `answer` must not assert facts that contradict the values in `rows` — if detected, module returns `LLM_ERROR`
- `confidence` is provided by the LLM and validated by the module — if the value is not a valid enum, the module returns `LLM_ERROR`

---

## 4. Output Contract — Failure

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

### Field Definitions

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `error.code` | string | yes | One of the defined error codes. |
| `error.message` | string | yes | Non-empty. Human-readable description of the failure. |
| `error.details` | object | yes | May be empty `{}`. Used for structured debugging context. |

---

## 5. Error Code Definitions

| Code | Meaning | Trigger |
|------|---------|---------|
| `INVALID_INPUT` | The input payload fails structural or constraint validation before reaching the LLM | Missing fields, wrong types, empty data, row limit exceeded, mixed element types |
| `INSUFFICIENT_DATA` | The data was valid and the question was clear, but the data does not contain enough information to answer | LLM explicitly signals no answer is possible from the provided data |
| `AMBIGUOUS_QUESTION` | The question has multiple valid interpretations and no single answer can be determined | LLM explicitly signals the question is ambiguous |
| `LLM_ERROR` | The LLM API call failed, timed out, or returned a response that could not be parsed into the required structure | API error, timeout, malformed JSON, missing required fields in LLM response, rows not found in input |

---

## 6. LLM Response Contract

The module sends the data and question to the LLM and expects a response in the following exact JSON format.

### Expected LLM Output Schema

```json
{
  "answer": "string",
  "rows": [...],
  "confidence": "low | medium | high",
  "status": "ok | insufficient_data | ambiguous"
}
```

### Field Definitions

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `answer` | string | yes | Non-empty if `status` is `"ok"`. May be empty string if `status` is not `"ok"`. |
| `rows` | array | yes | Rows from the input data that support the answer. May be empty. |
| `confidence` | string | yes | One of: `"low"`, `"medium"`, `"high"`. |
| `status` | string | yes | One of: `"ok"`, `"insufficient_data"`, `"ambiguous"`. |

### LLM Output Rules

- MUST be valid JSON
- MUST NOT include any text outside the JSON object (no preamble, no explanation, no markdown fences)
- MUST include all four fields: `answer`, `rows`, `confidence`, `status`
- Extra fields beyond the defined schema are ignored — not an error; should be logged when a logging system is available (v1: note only)
- `rows` MUST contain only rows matching the input by value equality — no paraphrasing, no synthesis

### Prompt Constraint (v1)

The prompt is responsible for enforcing the LLM response schema. The module must instruct the LLM to:

- Return only a JSON object — no surrounding text, no markdown code fences
- Include exactly the fields: `answer`, `rows`, `confidence`, `status`
- Use only the defined enum values for `confidence` and `status`
- Copy rows from the input as-is — no rephrasing or restructuring

The strictness of the output contract depends on the quality of the prompt. Prompt design is part of this module's implementation responsibility.

### Status Mapping

| LLM `status` | Module output |
|--------------|---------------|
| `"ok"` | `success: true` with `answer`, `rows`, `confidence` |
| `"insufficient_data"` | `success: false` with code `INSUFFICIENT_DATA` |
| `"ambiguous"` | `success: false` with code `AMBIGUOUS_QUESTION` |

---

## 7. Parsing Rules

Applied after receiving LLM response, before returning to caller.

| Condition | Action |
|-----------|--------|
| LLM response is not valid JSON | Return `LLM_ERROR` |
| LLM response is missing any required field (`answer`, `rows`, `confidence`, `status`) | Return `LLM_ERROR` |
| `status` is not one of `"ok"`, `"insufficient_data"`, `"ambiguous"` | Return `LLM_ERROR` |
| `confidence` is not one of `"low"`, `"medium"`, `"high"` | Return `LLM_ERROR` |
| Any row in `rows` does not match an input `data` row by value equality | Return `LLM_ERROR` |
| `answer` is empty string when `status` is `"ok"` | Return `LLM_ERROR` |

---

## 8. Validation Rules

Applied in order. First failure stops processing and returns error.

### Input Validation (pre-LLM)

1. `data` is present and is a non-empty array → else `INVALID_INPUT`
2. `data.length <= 1000` → else `INVALID_INPUT`
3. All elements of `data` are the same shape (all objects or all arrays) → else `INVALID_INPUT`
4. `question` is a non-empty, non-whitespace string → else `INVALID_INPUT`
5. If `context.columns` is provided: non-empty array of non-empty strings → else `INVALID_INPUT`
6. If `context.description` is provided: non-empty string → else `INVALID_INPUT`

### Output Validation (post-LLM)

7. LLM response parses as valid JSON → else `LLM_ERROR`
8. All required fields present → else `LLM_ERROR`
9. `status` is valid enum value → else `LLM_ERROR`
10. `confidence` is valid enum value → else `LLM_ERROR`
11. Every row in `rows` matches an input `data` row by value equality (key order ignored for objects) → else `LLM_ERROR`
12. If `status === "ok"`: `answer` is non-empty → else `LLM_ERROR`
13. If `status === "ok"`: `answer` does not contradict facts in `rows` → else `LLM_ERROR`

---

## 9. Edge Case Behavior

| Scenario | Behavior |
|----------|----------|
| `rows` is empty in a success response | Allowed. Covers two cases: (1) aggregation results that apply to the full dataset with no single supporting row, and (2) negative results where no rows match the condition (e.g. "no products are out of stock"). |
| LLM returns conflicting signals (e.g. `status: "ok"` but `answer` is empty) | `LLM_ERROR` — validation rule 12 fires |
| LLM returns a partial answer (missing one required field) | `LLM_ERROR` — validation rule 8 fires |
| LLM includes extra fields beyond schema | Extra fields are ignored — not an error; should be logged when a logging system is available (v1: note only) |
| No data matches filter but question was valid | Success with `rows: []` and `confidence: "high"` — LLM signals `status: "ok"` |
| Input data has > 1000 rows | `INVALID_INPUT` — LLM is never called |
| LLM API timeout | `LLM_ERROR` |

---

## 10. Examples

---

### Example A — Valid Success

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

**LLM Response:**
```json
{
  "answer": "Steel has the lowest stock with a value of 20.",
  "rows": [{ "product": "steel", "stock": "20" }],
  "confidence": "high",
  "status": "ok"
}
```

**Module Output:**
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

### Example B — Valid Failure (Ambiguous)

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

**LLM Response:**
```json
{
  "answer": "",
  "rows": [],
  "confidence": "low",
  "status": "ambiguous"
}
```

**Module Output:**
```json
{
  "success": false,
  "error": {
    "code": "AMBIGUOUS_QUESTION",
    "message": "The question cannot be answered from the data. No criteria for 'better' is defined.",
    "details": {}
  }
}
```

---

### Example C — Invalid LLM Response (Parsing Failure)

**LLM Response (raw text, not JSON):**
```
The product with the lowest stock is steel.
```

**Module Action:** JSON parse fails → `LLM_ERROR`

**Module Output:**
```json
{
  "success": false,
  "error": {
    "code": "LLM_ERROR",
    "message": "LLM response could not be parsed as valid JSON.",
    "details": {}
  }
}
```

---

### Example D — Invalid LLM Response (Row Not in Input)

**LLM Response:**
```json
{
  "answer": "Iron has low stock.",
  "rows": [{ "product": "iron", "stock": "5" }],
  "confidence": "high",
  "status": "ok"
}
```

**Module Action:** `{ "product": "iron", "stock": "5" }` does not match any input row by value equality → `LLM_ERROR`

**Module Output:**
```json
{
  "success": false,
  "error": {
    "code": "LLM_ERROR",
    "message": "LLM returned rows not found in the input data.",
    "details": {}
  }
}
```

---

## Status

Phase 2 complete. Awaiting approval for Phase 3: Technical Design.
