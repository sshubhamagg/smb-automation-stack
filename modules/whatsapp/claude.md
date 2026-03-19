# CLAUDE SYSTEM INSTRUCTIONS — MODULAR AI AUTOMATION TOOLKIT

## 🧠 PROJECT VISION

We are building a modular AI automation toolkit for small and medium businesses.

This is NOT a full product yet.

The goal is to create **independent, production-ready modules** that can later be composed into different business solutions.

Each module must:

* Work standalone
* Be testable independently
* Have strict input/output contracts
* Be reusable across use cases

---

## ⚙️ CORE MODULES

We are building ONLY the following modules:

1. WhatsApp Interface Module
2. Google Sheets Adapter Module
3. AI Processing Module
4. Rules Engine Module
5. Notification Module

---

## 🚫 HARD CONSTRAINTS

* DO NOT build a full system
* DO NOT connect modules together
* DO NOT assume other modules exist
* DO NOT create cross-module dependencies
* DO NOT introduce heavy infrastructure

Each module must function independently.

---

## 🧩 DESIGN PRINCIPLES

* Contract-first design (define I/O before logic)
* JSON-based communication formats
* Minimal external dependencies
* High readability and simplicity
* Strong logging and error handling
* Config-driven behavior (no hardcoding)

---

## 🔌 MODULE ISOLATION RULE

Each module must:

* Accept input via API / function / CLI
* Return output in a standard JSON format
* NOT call other modules internally
* Be runnable and testable on its own

---

## 🔄 DEVELOPMENT PROCESS (STRICT)

For EACH module, follow this exact sequence:

---

### PHASE 1: MODULE DEFINITION

* Define purpose
* Define responsibilities
* Define boundaries (what it does NOT do)
* WAIT for approval

---

### PHASE 2: CONTRACT DESIGN

* Define input JSON schema
* Define output JSON schema
* Define API endpoints (if applicable)
* Provide 3–5 realistic examples
* WAIT for approval

---

### PHASE 3: TECHNICAL DESIGN

* Internal architecture
* Key components
* Data flow within module
* Error handling strategy
* WAIT for approval

---

### PHASE 4: IMPLEMENTATION PLAN

* Folder structure
* Files and responsibilities
* Dependencies
* Test strategy
* WAIT for approval

---

### PHASE 5: IMPLEMENTATION

* Write clean, minimal code
* Add logging
* Add validation
* Provide run instructions

---

### PHASE 6: TESTING

* Provide test cases
* Provide sample inputs
* Provide expected outputs
* Include edge cases

---

## 🧪 TESTING REQUIREMENTS

Each module must include:

* Happy path tests
* Failure scenarios
* Edge cases
* Input validation tests

---

## 📦 OUTPUT FORMAT RULES

* Use structured markdown
* Use clear headings
* Use JSON/code blocks for schemas
* Keep explanations concise and practical

---

## 🎯 INITIAL TASK

Start with:

👉 Module 1: WhatsApp Interface Module

Begin with:
PHASE 1: MODULE DEFINITION

Include:

* Scope
* Responsibilities
* Non-responsibilities
* Example usage

---

## 🧭 SUCCESS CRITERIA

A module is complete only if:

* It runs independently
* It has clear contracts
* It is fully testable
* It does not depend on other modules

---

## ⚠️ STRICT WARNING

If you:

* Skip phases
* Start coding early
* Reference other modules

You are violating instructions.

Follow the process strictly.

---
---

## 📚 DOCUMENTATION & CHANGELOG REQUIREMENTS (MANDATORY)

### 📁 Documentation Structure

All outputs MUST be persisted as markdown files inside `/docs`.

Structure:

/docs
├── module-1-whatsapp/
│     ├── phase-1-module-definition.md
│     ├── phase-2-contract-design.md
│     ├── phase-3-technical-design.md
│     ├── phase-4-implementation-plan.md
│     └── phase-5-implementation.md

---

### 📝 Phase Documentation Rules

For EVERY phase:

* Save output to corresponding file in `/docs`

* File must contain:

  * Title
  * Phase name
  * Timestamp
  * Version (v1, v2, etc.)
  * Full structured content

* If a phase is refined:

  * Create a new version (v2, v3…)
  * Overwrite file with latest version
  * DO NOT lose previous context — summarize changes

---

### 🧾 CHANGELOG REQUIREMENTS

Maintain a root-level file:

`CHANGELOG.md`

---

### Format:

Each update must append:

## [YYYY-MM-DD] — <Short Title>

### Added

* New features or sections

### Updated

* What changed (be specific)

### Fixed

* Bugs or corrections

### Notes

* Reason for change (important for audit)

---

### What must be logged:

* Every phase completion
* Every refinement
* Every schema change
* Every behavioral change
* Every file creation

---

### 🔒 CHANGELOG RULES

* NEVER overwrite previous entries
* ALWAYS append
* Keep entries concise but specific
* Use bullet points only

---

### 🧠 VERSIONING RULE

* Each phase starts at v1
* Every refinement increments version
* Version must be reflected:

  * In document title
  * In changelog

---

### 📌 WORKFLOW ENFORCEMENT

After completing ANY phase or refinement:

1. Generate the markdown file content
2. Specify file path (e.g., `/docs/module-1-whatsapp/phase-2-contract-design.md`)
3. Generate CHANGELOG entry
4. WAIT for approval

DO NOT proceed automatically.

---

END OF DOCUMENTATION INSTRUCTIONS

