# VC Engine — Execution Tickets

---

## TASK 1: Read and Normalize Data

### Input
- Google Sheets:
  - orders
  - marketing
  - costs

### Output

ctx.state.data.enriched


### Logic
- read all sheets
- map columns using config
- convert strings → numbers
- join datasets by SKU + date

### Integration
- storage module (read)

### Constraints
- handle missing fields
- ensure consistent schema

---

## TASK 2: Compute Metrics

### Input

ctx.state.data.enriched


### Output

ctx.state.data.metrics


### Logic
For each row:
- roas = revenue / spend
- cac = spend / orders
- aov = revenue / orders
- margin = revenue - spend - cost

### Constraints
- no division by zero
- safe numeric parsing

---

## TASK 3: Aggregate Metrics

### Input

ctx.state.data.metrics


### Output

ctx.state.data.aggregates


### Logic
Group by:
- channel
- SKU
- date

Compute:
- total revenue
- avg roas
- avg cac

---

## TASK 4: Evaluate Rules

### Input

ctx.state.data.aggregates
ctx.state.config.thresholds


### Output

ctx.state.data.alerts


### Logic
- if roas < threshold → LOW_ROAS
- if cac > threshold → HIGH_CAC
- if margin < 0 → NEGATIVE_MARGIN

---

## TASK 5: Generate CEO Snapshot

### Input
- aggregates
- alerts

### Output

ctx.state.data.snapshot


### Logic
- total revenue
- avg CAC
- avg ROAS
- top channel
- worst channel
- alert summary

---

## TASK 6: Write Outputs

### Input
- metrics
- aggregates
- alerts
- snapshot

### Output
- Google Sheets tables

### Integration
- storage module (write)

---

## TASK 7: Orchestrator Flow Execution

### Input
- config
- trigger

### Output
- final execution result

### Logic
- sequentially run flows
- pass context forward

---

## GLOBAL CONSTRAINTS

- flows must not throw
- no external API calls
- use ctx.state for data sharing
- use ctx.outputs for step outputs
- deterministic logic only

---

## SUCCESS CRITERIA

- system processes 100k rows
- outputs correct metrics
- generates alerts
- produces CEO summary