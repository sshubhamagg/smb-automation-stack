# Claude Code Execution Guide — Sheets Module

We are building a **standalone Google Sheets module**.

This is NOT a system.
This is NOT part of WhatsApp.
This is NOT coupled to any other module.

This module must be:
- Independent
- Minimal
- Fully testable
- Reusable across SMB use cases

---

# Core Principles

1. **Single Responsibility**
   - Only handle Google Sheets read/write operations

2. **No Business Logic**
   - Do not interpret data
   - Do not apply domain rules

3. **No External Dependencies (Logic-wise)**
   - No WhatsApp
   - No AI
   - No orchestration

4. **Schema Agnostic**
   - Do not assume column names or structure

5. **Deterministic Behavior**
   - Same input → same output

6. **Minimalism**
   - No abstractions unless necessary
   - No over-engineering

---

# Supported Operations (v1)

- Read sheet (full or range)
- Append row
- Update row
- Search rows (simple key-value match)

---

# Process to Follow

You MUST follow phases strictly:

### PHASE 1 — Module Definition
- Define purpose, responsibilities, boundaries
- No code

### PHASE 2 — Contract Design
- Define input/output JSON structures
- Define error formats

### PHASE 3 — Technical Design
- Define components
- Define flow
- Define API surface

### PHASE 4 — Implementation Plan
- Folder structure
- Files
- Dependencies
- Test plan

### PHASE 5 — Implementation
- Write full code
- Write tests
- Ensure everything runs

---

# Rules

- Do NOT skip phases
- Do NOT write code before Phase 5
- Do NOT introduce unnecessary abstraction
- Do NOT reference other modules
- Keep everything simple and explicit

---

# Output Expectations

Each phase must:
- Be written to `/docs/module-2-sheets/`
- Update `CHANGELOG.md`
- Wait for approval before proceeding

---

# Goal

A clean, minimal, production-ready Google Sheets module
that can be used independently in any SMB workflow.