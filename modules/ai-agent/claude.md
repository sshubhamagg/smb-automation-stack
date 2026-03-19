# Claude Execution Guide — AI Analysis Module

This module is a PURE FUNCTION.

It analyzes structured data and answers questions using an LLM.

---

## CORE PRINCIPLE

This module is NOT an agent.

Do NOT introduce:
- tool usage
- multi-step planning
- memory or sessions
- orchestration logic
- workflow engines

This module must remain:
- stateless
- minimal
- deterministic in structure

---

## FUNCTIONAL MODEL

The module behaves like:

analyze({
  data: [...],
  question: "..."
})

→ returns structured answer

---

## ARCHITECTURE RULES

- No HTTP server unless explicitly required
- No background jobs
- No queues
- No retries
- No caching
- No database usage

---

## LLM USAGE RULES

- Use LLM only for reasoning over provided data
- Do NOT fetch external knowledge
- Do NOT hallucinate missing values
- Always constrain responses to given data

---

## INPUT CONSTRAINTS

- Data is always provided at runtime
- Data is small (≤ 1000 rows)
- Values are strings
- Schema is unknown and dynamic

---

## OUTPUT CONSTRAINTS

All outputs must follow a strict contract:

- success response OR error response
- no free-form outputs
- no extra fields

---

## ERROR HANDLING

- Never throw raw errors
- Always return structured error responses
- Prefer failure over guessing

---

## IMPLEMENTATION PHILOSOPHY

- Keep logic minimal
- Avoid abstractions unless necessary
- Prefer clarity over flexibility
- Do not optimize prematurely

---

## TESTING RULES

- Mock LLM calls
- Do not call real APIs in tests
- Cover:
  - valid cases
  - ambiguous questions
  - insufficient data
  - malformed input

---

## DOCUMENTATION FLOW

Follow strictly:

1. Phase 1 — Module Definition
2. Phase 2 — Contract Design
3. Phase 3 — Technical Design
4. Phase 4 — Implementation Plan
5. Phase 5 — Implementation

Do NOT skip phases.
Do NOT write code before Phase 4 approval.

---

## CHANGELOG

Every phase must:
- update CHANGELOG.md
- include clear summary of additions/changes

---

## NON-NEGOTIABLES

- No agent frameworks
- No orchestration logic
- No cross-module references
- No hidden state

---

## STOP CONDITIONS

If you detect:
- increasing complexity
- unclear responsibility
- need for orchestration

STOP and ask for clarification.

---

This module must remain simple enough to:
- plug into WhatsApp
- plug into Sheets
- plug into any future system

WITHOUT modification.