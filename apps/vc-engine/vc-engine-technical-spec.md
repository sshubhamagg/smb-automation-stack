# VC Engine — Technical Specification

## 1. Architecture Overview

System follows flow-based execution model:

App Handler → Sequential Flows → State Mutation → Output

Aligned with system context:
- flows contain business logic
- modules handle I/O
- orchestrator manages execution

---

## 2. Folder Structure


apps/vc-engine/
flows/vc-engine/
├── read-and-normalize/
├── compute-metrics/
├── aggregate-metrics/
├── evaluate-rules/
├── generate-output/


---

## 3. Execution Pipeline

Handler executes flows sequentially:

1. read-and-normalize
2. compute-metrics
3. aggregate-metrics
4. evaluate-rules
5. generate-output

Flows do not call other flows.

---

## 4. Context Model


ctx.state = {
config: {},
data: {
orders: [],
marketing: [],
costs: [],
enriched: [],
metrics: [],
aggregates: [],
alerts: [],
snapshot: {}
}
}


---

## 5. Flow Design

### Flow 1: read-and-normalize

Responsibilities:
- read sheets using storage module
- normalize column names
- convert data types
- join datasets

---

### Flow 2: compute-metrics

Responsibilities:
- compute row-level metrics
- update ctx.state.data.metrics

Constraints:
- no division by zero
- safe numeric parsing

---

### Flow 3: aggregate-metrics

Responsibilities:
- group data by:
  - channel
  - SKU
  - date

---

### Flow 4: evaluate-rules

Responsibilities:
- apply threshold-based rules
- generate alerts

---

### Flow 5: generate-output

Responsibilities:
- write outputs to sheets
- generate CEO snapshot

---

## 6. Storage Module Usage


{
provider: 'sheets',
operation: 'read' | 'write',
resource: sheetId,
options: { range }
}


---

## 7. Performance Design

### Target: 100k rows

Strategies:
- single-pass computations
- minimal data copying
- in-memory processing
- chunk-ready structure

---

## 8. Error Handling

Must handle:
- missing values
- invalid numbers
- empty datasets
- schema mismatch

---

## 9. Utility Functions


safeNum(x)
safeDivide(a, b)


---

## 10. Constraints (System-Level)

- no API calls in flows
- no direct DB access
- only storage/communication/intelligence modules allowed
- no side effects outside flows
- input() and condition() must not throw

---

## 11. Extensibility

Future:
- AI integration in rule evaluation
- incremental computation
- multi-tenant orchestration