# CHANGELOG

---

## [2026-03-23] — System Audit + Documentation Rebuild

### Updated (Documentation)
* Rebuilt all docs to match actual code — removed all references to non-existent `apps/orchestrator/`
* `docs/architecture.md` — corrected layer diagram; documented two separate apps (`apps/ledger/`, `apps/mining/`) with their distinct responsibilities
* `docs/modules.md` — added `local` (Ollama) and `nvidia` (NVIDIA NIM) intelligence adapters; updated all adapter tables
* `docs/use-cases.md` — full rewrite of Ledger section: documented all 6 flows (intent-router + 5 sub-flows), AI mode, ledger-party, ledger-delete
* `docs/engine.md` — fixed reliability mechanism file references to `apps/mining/src/server.ts`
* `docs/context.md` — added context shapes for all ledger flows; fixed app references
* `docs/flows.md` — documented multi-flow dispatch pattern used by ledger; fixed app references
* `docs/agent-guide.md` — added `'local'` and `'nvidia'` as valid intelligence providers
* `docs/constraints.md` — fixed webhook constraint to reference both apps
* `docs/limitations.md` — added ledger soft-delete limitation; fixed all file references
* `docs/developer-guide.md` — fixed all app references from orchestrator to `apps/mining/` and `apps/ledger/`
* `docs/adapters.md` — added local and nvidia adapters to intelligence table

### Added
* `docs/backlog.md` — consolidated backlog with bugs, architectural improvements, performance issues, DX improvements, and AI reliability items; all traced to code

---

## [2026-03-21] — Ledger App — WhatsApp Financial Ledger

### Added
* Created `apps/ledger/` — standalone Express app for ledger operations
* `apps/ledger/src/server.ts` — Express server, Meta webhook endpoint, ingestion pipeline
* `apps/ledger/src/handler.ts` — `handleLedgerMessage()` — two-phase dispatch: intent-router flow then sub-flow
* Created `flows/ledger/` with intent-router and five sub-flows:
  * `flows/ledger/intent-router/flow.ts` — `buildInitialContext()`, `intentRouterFlow`, `resolveRouting()`; structured parsing + optional AI classification/extraction
  * `flows/ledger/ledger-entry/flow.ts` — duplicate check, conditional write, confirmation/warning message
  * `flows/ledger/ledger-balance/flow.ts` — reads all rows, computes net credits/debits/balance
  * `flows/ledger/ledger-summary/flow.ts` — filters today's rows, sends daily summary
  * `flows/ledger/ledger-party/flow.ts` — filters by party name (case-insensitive), sends ledger
  * `flows/ledger/ledger-delete/flow.ts` — soft-deletes last user row (blank overwrite), sends confirmation
* `flows/ledger/package.json`, `tsconfig.json`
* `docs/ledger-flow/setup.md` — end-to-end setup guide

### Notes
* Two modes: `LEDGER_MODE=structured` (default, deterministic) and `LEDGER_MODE=ai` (LLM classification + extraction when structured parse fails)
* AI provider configurable: `LEDGER_AI_PROVIDER` — supports all four registered providers (openai, anthropic, local, nvidia)
* Config injected via `ctx.state.config` from env vars — no hardcoded values
* `ledger-entry` checks for duplicates (same type+amount+party+user) before writing

---

## [2026-03-19] — Module 3: Phase 5 — Implementation

### Added
* Created `modules/ai-agent/` with flat structure: `src/` (9 files) + `tests/` (6 files)
* Implemented all 9 source files: `config.ts`, `logger.ts`, `validator.ts`, `promptBuilder.ts`, `llmClient.ts`, `parser.ts`, `postValidator.ts`, `handler.ts`, `main.ts`
* Implemented all 6 test files: `validator.test.ts`, `promptBuilder.test.ts`, `parser.test.ts`, `postValidator.test.ts`, `llmClient.test.ts`, `handler.test.ts`
* Three-stage JSON extraction in `parser.ts`: markdown fences → `{…}` substring → direct parse
* Provider-agnostic LLM client using Node 18 built-in `fetch` + `AbortController` with one retry on network error
* `checkContradiction` returns `false` in v1 (documented limitation — no NLP feasible)
* `handler.ts` measures `latencyMs` from receive to return; logs `{ operation, status, errorCode, latencyMs }` — no data/question/answer logged
* All TypeScript strict mode — zero errors
* 109/109 tests passing across 6 test suites

### Fix
* Added top-level JSON array guard in `parse()`: rejects `[…]` responses before substring extraction stage, preventing object extraction from inside arrays

---

## [2026-03-19] — Module 3: Phase 4 — Implementation Plan

### Added
* Created `docs/module-3-ai/phase-4-implementation-plan.md`
* Defined flat folder structure: `src/` (9 files) + `tests/` (6 files)
* Defined file responsibilities for all 9 source files
* Defined function-level design for all 9 files: `analyze()`, `handle()`, `validateInput()`, `buildPrompt()`, `callLLM()`, `parse()`, `validate()`, `log()`
* Defined 4 environment variables: `LLM_API_KEY` (required), `LLM_PROVIDER`, `LLM_TIMEOUT_MS`, `LOG_LEVEL`
* Defined runtime dependencies: `dotenv` only; LLM calls via Node 18 built-in `fetch` — no SDK
* Defined dev dependencies: `typescript`, `jest`, `ts-jest`, `@types/node`, `@types/jest`, `tsx`
* Defined test strategy: 6 test files with explicit approach and coverage per file
* Defined mock strategy: `fetch` mocked for llmClient; llmClient + logger mocked for handler; all other files pure
* Defined 7 implementation rules: no classes, no async side effects outside handler, no extra retries, no data logging, strict typing, pure functions, single public export

---

## [2026-03-19] — Module 3: Phase 3 — Refinement (v2)

### Updated
* Improved parser robustness: replaced single-pass fence extraction with three-stage JSON extraction strategy (fence → `{…}` substring → direct parse)
* Added **JSON Extraction Strategy** section with explicit stage-by-stage logic
* Added provider-agnostic design note to LLM Client: interface stable across providers, configured via environment
* Clarified contradiction detection scope: direct value conflicts only, no semantic reasoning
* Added token awareness note to Prompt Builder: no truncation in v1; 1000-row limit is the token budget mechanism
* Added extraction failure as distinct error mapping row in error handling flow
* Clarified `latencyMs`: measured from Handler receive to Handler return

---

## [2026-03-19] — Module 3: Phase 3 — Technical Design

### Added
* Created `docs/module-3-ai/phase-3-technical-design.md`
* Defined single-process pipeline architecture with 7 components: Handler, Validator, Prompt Builder, LLM Client, Parser, Post-Validator, Logger
* Defined full data flow: 7 sequential steps from input to output, with failure exits at each stage
* Defined system prompt and user prompt structure; prompt owns schema enforcement, "no extra text" rule
* Defined LLM Client interface: single `callLLM()`, 10s timeout, max 1 retry on network failure only, no retry on bad output
* Defined Parser: markdown fence extraction + JSON.parse; fails on partial or multi-object responses
* Defined Post-Validator: 8 ordered checks covering field presence, enums, row matching, contradiction; row matching logic for object (key order ignored) and array (order significant) types
* Defined error handling flow: all pipeline stages mapped to module error codes, no uncaught exceptions
* Defined log schema: `{ operation, status, errorCode, latencyMs }` — no data, question, or answer logged
* Defined performance constraints: 1000 row max, <5s expected, no streaming
* Explicitly listed 6 v1 simplifications: no caching, batching, streaming, concurrency, multi-step, memory

---

## [2026-03-19] — Module 3: Phase 2 — Refinement (v2)

### Updated
* Relaxed row matching from verbatim to value-based equality — key order variation allowed for object rows
* Added **Row Matching Rules** section: object matching (key order ignored, all keys must match), array matching (order significant)
* Updated extra field rule: extra LLM fields ignored but should be logged when logging system available (v1: note only)
* Added **Prompt Constraint (v1)** section: prompt is responsible for enforcing LLM schema; defined 4 prompt requirements
* Clarified confidence: provided by LLM, validated by module — invalid value → `LLM_ERROR`
* Added validation rule 13: if `answer` contradicts `rows` → `LLM_ERROR`
* Updated edge case for empty `rows`: now covers both aggregation results and negative results (no matching data)
* Updated Example D action text to reflect value-based equality language

---

## [2026-03-19] — Module 3: Phase 2 — Contract Design

### Added
* Created `docs/module-3-ai/phase-2-contract-design.md`
* Defined standard response envelope: `success`/`data`/`error` — mutually exclusive success and error
* Defined full input contract: field types, required/optional, validation rules, data constraints
* Defined success output contract: `answer`, `rows`, `confidence` with invariants (rows are verbatim subset, answer must not contradict rows)
* Defined failure output contract: `code`, `message`, `details`
* Defined 4 error codes with exact trigger conditions
* Defined LLM response contract: strict JSON schema with `answer`, `rows`, `confidence`, `status` fields; no text outside JSON
* Defined 6 parsing rules: invalid JSON, missing fields, bad enum, rows not in input → all `LLM_ERROR`
* Defined 12 ordered validation rules (6 pre-LLM input, 6 post-LLM output)
* Defined 7 edge case behaviors: empty rows, conflicting signals, partial answers, extra fields, timeout
* Provided 4 examples: valid success, valid failure, invalid LLM JSON, hallucinated row

---

## [2026-03-19] — Module 3: Phase 1 — Refinement (v2)

### Updated
* Clarified probabilistic nature of LLM outputs — determinism not guaranteed
* Relaxed preprocessing boundary: semantic transformation still prohibited; structural handling (size limits, normalization) now permitted
* Defined row limit behavior: `INVALID_INPUT` returned if data exceeds 1000 rows; no silent truncation
* Improved confidence definition: heuristic-based, not purely LLM-reported
* Added LLM parsing requirement: unparseable response → `LLM_ERROR`
* Defined numeric interpretation rule: LLM may treat numeric strings as numbers; module does not enforce types
* Corrected Scenario 4 (no matching data): now returns success with `rows: []` instead of failure
* Added explainability rule: answers should include concise reasoning tied to specific rows

---

## [2026-03-19] — Module 3: Phase 1 — Module Definition

### Added
* Created `docs/module-3-ai/phase-1-module-definition.md`
* Defined purpose: pure function module — accepts tabular data + question, returns LLM-generated answer + supporting rows
* Defined 9 responsibilities: data ingestion, question handling, LLM call, answer + rows + confidence output, graceful failure on ambiguity and insufficient data
* Defined strict boundaries: no storage, no external calls except LLM, no state, no workflow, no schema assumptions
* Defined input shape: `{ data, question, context? }` — data as objects or arrays, all values strings
* Defined output shape: `{ success, data: { answer, rows, confidence } }` or `{ success: false, error }`
* Defined 4 error codes: `INVALID_INPUT`, `INSUFFICIENT_DATA`, `AMBIGUOUS_QUESTION`, `LLM_ERROR`
* Defined 7 behavior rules: data-only answers, no hallucination, no type assumptions, verbatim supporting rows
* Defined 5 example scenarios: lowest value, filter condition, aggregation, no match, ambiguous question

### Notes
* Standalone module — no dependency on any other module
* Stateless by design — no memory, no session, no caching

---

## [2026-03-18] — Module 2: Phase 5.1 — Stabilization

### Updated
* Documented internal `headerValid` flag in Phase 3 Technical Design (Transformer component section)
* Documented internal `headerValid` flag in Phase 4 Implementation Plan (transformer.ts function list)
* Clarified that `headerValid` is not part of public contract — internal handler use only
* Added Design Notes section in README: sync logging rationale + headerValid scope

---

## [2026-03-18] — Module 2: Phase 5 — Implementation

### Added
* Full implementation of Google Sheets module in `modules/sheets/`
* `src/config.ts` — env loading with fail-fast validation, frozen Config object
* `src/logger.ts` — structured JSON logging, LOG_LEVEL aware, non-blocking stdout
* `src/validator.ts` — per-operation input validation, returns structured INVALID_INPUT errors
* `src/transformer.ts` — pure functions: isValidHeader, mapRows, transformRead, transformWrite; headerValid flag
* `src/sheetsClient.ts` — JWT auth init once, getValues/appendValues/updateValues with structured { success, data/error } returns, no throws on API errors
* `src/handler.ts` — orchestrates all 4 operations, performs search filtering (exact, case-sensitive, AND), catches all errors
* `src/main.ts` — exports read(), append(), update(), search(); no HTTP server
* `tests/validator.test.ts` — 24 test cases, pure function tests
* `tests/transformer.test.ts` — 18 test cases, pure function tests
* `tests/sheetsClient.test.ts` — 14 test cases, googleapis mocked
* `tests/handler.test.ts` — 24 test cases, integration tests with mocked client
* `package.json`, `tsconfig.json`, `.env.example`, `README.md`

### Notes
* 80/80 tests passing across 4 test suites
* TypeScript strict mode: zero compiler errors (tsc --noEmit clean)
* Google API never called in tests — all mocked via jest.mock('googleapis')
* headerValid flag added to TransformReadResult to enable correct search error detection in handler

---

## [2026-03-18] — Module 2: Phase 4 — Refinement (v2)

### Updated
* Moved search filtering from `transformer.ts` to `handler.ts` — correct separation of concerns
* Updated `sheetsClient.ts` to return structured results (`{ success, data/error }`) instead of throwing on API errors

---

## [2026-03-18] — Module 2: Phase 4 — Implementation Plan (v1)

### Added
* Created `docs/module-2-sheets/phase-4-implementation-plan.md`
* Defined flat folder structure: `src/` (7 files) + `tests/` (4 files)
* Defined file responsibilities and function-level responsibilities for all 7 source files
* Defined runtime dependencies: `googleapis`, `dotenv` only
* Defined dev dependencies: `typescript`, `jest`, `ts-jest`, `@types/node`, `@types/jest`
* Defined environment variables: `GOOGLE_SERVICE_ACCOUNT_JSON` (required), `LOG_LEVEL` (optional)
* Defined Google JWT auth setup: initialized once in `sheetsClient`, reused across calls
* Defined test strategy: pure function tests for validator/transformer, mocked API tests for sheetsClient, integration tests for handler

---

## [2026-03-18] — Module 2: Phase 3 — Refinement (v2)

### Updated
* Fixed search behavior when header is missing — now returns explicit `INVALID_INPUT` error instead of empty rows
* Aligned all four operation flows with standardized response envelope `{ success, data, metadata }`

---

## [2026-03-18] — Module 2: Phase 3 — Technical Design (v1)

### Added
* Created `docs/module-2-sheets/phase-3-technical-design.md`
* Defined single-process architecture with 5 components: Handler, Validator, Sheets Client, Transformer, Logger
* Defined step-by-step operation flows for read, append, update, search
* Defined Google Sheets API v4 method mapping: values.get, values.append, values.update
* Defined Service Account auth model: JSON key via env, single init, no OAuth
* Defined header detection and fallback logic — owned exclusively by Transformer
* Defined in-memory search filter logic — strict string equality, AND, case-sensitive, O(n*k)
* Defined error category table with HTTP status codes and error codes
* Defined structured JSON logging schema — one log line per operation, no row data logged

---

## [2026-03-18] — Module 2: Phase 2 — Refinement (v2)

### Updated
* Added header fallback behavior to read and search output schemas: objects when header valid, arrays when header missing/malformed
* Made `range` optional for read operation — entire sheet is read when omitted
* Defined explicit update overwrite rules: full row replacement, fewer values clears remaining cells, extra values ignored

---

## [2026-03-18] — Module 2: Phase 2 — Contract Design (v1)

### Added
* Created `docs/module-2-sheets/phase-2-contract-design.md`
* Defined input/output/error contracts for read, append, update, search
* Standardized response schema across all operations: `{ success, data?, metadata?, error? }`
* Defined 7 error codes: `INVALID_INPUT`, `SHEET_NOT_FOUND`, `RANGE_NOT_FOUND`, `ROW_NOT_FOUND`, `AUTH_FAILED`, `API_ERROR`, `INTERNAL_ERROR`
* Defined search as exact match, case-sensitive, AND-only, strings only — no partial, regex, or fuzzy

---

## [2026-03-18] — Module 2: Phase 1 — Refinement (v2)

### Updated
* Relaxed header handling to avoid failures on malformed sheets
* Defined strict search behavior (exact match, case-sensitive, AND-only)

---

## [2026-03-18] — Module 2: Phase 1 — Module Definition (v1)

### Added
* Created `docs/module-2-sheets/phase-1-module-definition.md`
* Defined purpose: minimal, generic data layer for reading and writing Google Sheets
* Defined 5 core responsibilities: read full sheet, read range, append row, update row, search rows
* Defined boundaries: no business logic, no AI, no schema assumptions, no caching, no side effects
* Defined input fields: `sheetId`, `range`, `row`, `filter`, `rowIndex`
* Defined output format: JSON rows for reads/search, success + updatedRange for writes, standardized error shape
* Defined behavior rules: first row = headers, all values as strings, no type coercion, empty cells = `""`
* Defined 5 example scenarios: read, append, search, update, no-match
* Defined provider: Google Sheets API v4 with Service Account auth
* Defined out of scope for v1: batch ops, multi-sheet, sorting, aggregation, formula eval, sheet management

### Notes
* Standalone module — no dependency on WhatsApp or AI modules
* Schema-agnostic by design — column names are dynamic, derived from header row

---

## [2026-03-18] — Module 1: Phase 1 — Initial Module Definition (v1)

### Added
* Created `docs/module-1-whatsapp/phase-1-module-definition.md`
* Defined purpose: standardized boundary for receiving/sending WhatsApp messages
* Defined core responsibilities: inbound receive, normalization, outbound send, webhook verification, logging
* Defined boundaries: no business logic, no DB persistence, no cross-module calls
* Defined provider assumption: WhatsApp Business Cloud API (Meta)
* Added 4 example scenarios: inbound text, outbound send, webhook verification, malformed payload

### Notes
* Initial definition pass — broad strokes, no schema detail yet

---

## [2026-03-18] — Module 1: Phase 1 — Refinement (v2)

### Updated
* Normalization responsibility made explicit: E.164 phone format, extract `message_id`, `timestamp` (UTC ISO 8601), `message_type`, `text_body`, `media_metadata`
* Idempotency added: detect/handle duplicate webhook events by `message_id`, safe re-processing
* Output behavior clarified: module returns normalized message as direct API response — no event bus or external dispatch
* Logging definition strengthened: log `message_id`, `user_id`, sanitized raw payload, normalized output, status, errors as structured JSON to stdout
* Media handling scoped: v1 supports text only; media passed as raw `media_metadata`, `message_type` set to `"unsupported"`

### Notes
* Refinement driven by need to make contracts explicit before schema design

---

## [2026-03-18] — Module 1: Phase 1 — Refinement (v3)

### Added
* Payload structure validation: explicit check of WhatsApp Cloud API structure; fail safely on unknown formats with HTTP 400
* HTTP response strategy table: 200 (success/duplicate), 400 (invalid), 401 (signature), 429 (rate limit), 500 (internal), 502 (provider)
* Rate limiting: inbound per-sender (configurable), outbound throttling — both backed by persistent store
* Outbound tracking: `correlation_id` in request/response, `provider_message_id` returned on success

### Updated
* Idempotency store requirement strengthened: MUST be persistent (Redis, SQLite, or configurable KV store); in-memory not acceptable; configurable TTL (default 24h)

### Notes
* Refinement driven by need to harden operational guarantees before contract design

---

## [2026-03-18] — Module 1: Phase 2 — Initial Contract Design (v1)

### Added
* Created `docs/module-1-whatsapp/phase-2-contract-design.md`
* Raw inbound webhook payload schema with validation rules table
* Normalized message output schema (8 fields, required/optional annotated)
* Outbound send request schema (3 fields)
* Outbound send response schema with `status: "sent"` (later revised)
* Standardized error response schema with 7 error codes
* 3–5 real examples per schema

### Notes
* First pass at strict JSON contracts following Phase 1 approval

---

## [2026-03-18] — Module 1: Phase 2 — Refinement (v2)

### Added
* Multi-message handling rule: only `messages[0]` processed in v1; subsequent entries ignored and logged with `status: "ignored"`
* Ordering disclaimer: provider does not guarantee message ordering; module does not enforce it
* Webhook timeout constraint: must respond within configurable timeout (default 5 seconds); return HTTP 200 on timeout to prevent provider retry

### Updated
* `correlation_id` in error responses is now **always required** — module generates a UUID if not available from request context
* Outbound status `"sent"` replaced with `"accepted"` — clarifies API acceptance only, not delivery to recipient
* Status values table updated with explicit semantics for `accepted`, `failed`, `throttled`

### Fixed
* Error schema was inconsistent — `correlation_id` was previously optional; now mandatory in all error responses

### Notes
* Refinements address edge cases in multi-message payloads, traceability gaps, and status ambiguity

---

## [2026-03-18] — Module 1: Phase 3 — Initial Technical Design (v1)

### Added
* Created `docs/module-1-whatsapp/phase-3-technical-design.md`
* Defined single-service architecture with 6 internal components (no microservices)
* Defined full request lifecycle for inbound webhook, webhook verification, outbound send
* Defined component responsibilities: handler, validator, normalizer, idempotency, rate limiter, outbound client
* Defined storage strategy: Redis (primary) / SQLite (fallback), abstract interface, two key namespaces
* Defined error classification table: validation, rate limit, provider, internal, store errors
* Defined structured JSON logging schema with PII sanitization rules

### Notes
* Technical design translates Phase 2 contracts into concrete internal architecture

---

## [2026-03-18] — Module 1: Phase 3 — Refinement (v2)

### Added
* Atomic idempotency: SETNX pattern with `"processing"` sentinel to prevent race conditions
* Two-tier rate limiting: global check (before parsing) + per-user check (after phone extraction)
* `GET /health` endpoint returning `{status, service, store, timestamp}` with `ok`/`degraded` states
* Timeout safety rules: unsafe timeout (`timeout_unsafe`) logged explicitly when timeout fires before idempotency write
* Log payload size limits: `raw_payload` max 2 KB, `normalized_output` max 1 KB, `text_body` max 50 chars, total log line max 4 KB; all configurable

### Updated
* Outbound client: clarified no automatic retries under any condition — single attempt only, caller is responsible
* Rate limiter: restructured into Tier 1 (global, pre-parse) and Tier 2 (per-user, post-parse)
* Request lifecycle diagrams updated to reflect two-tier rate limiting and timeout safety rules

### Notes
* Refinements harden operational correctness, prevent race conditions, and add observability for unsafe states

---

## [2026-03-18] — Module 1: Phase 4 — Implementation Plan (v1)

### Added
* Created `docs/module-1-whatsapp/phase-4-implementation-plan.md`
* Defined flat folder structure: `src/` (10 files) + `tests/` (6 files) — no sub-packages, no deep nesting
* Defined file responsibilities table for all 16 files
* Defined component-to-file mapping for all 10 components
* Defined function-level responsibilities for every function in every file
* Defined full environment variable table (17 variables, required/optional/defaults)
* Defined minimal runtime dependency list: 5 packages (fastapi, uvicorn, httpx, redis, python-dotenv)
* Defined local development setup steps (7 steps, SQLite fallback option included)
* Defined test strategy: 6 test files, 47 test cases covering happy path, duplicates, errors, edge cases, degraded store

### Notes
* Language/framework selected: Python 3.11+ with FastAPI — clean, async-capable, minimal dependencies
* SQLite built-in to Python — no extra dependency for fallback store
* Test files mirror source files 1:1 for navigability

---

## [2026-03-18] — Module 1: Phase 4 — Node.js Migration (v2)

### Updated
* Migrated language and framework: Python 3.11 + FastAPI → Node.js 18+ + TypeScript + Fastify
* Replaced `requirements.txt` with `package.json` (with `start`, `dev`, `build`, `test` scripts)
* Added `tsconfig.json` to project structure
* File extensions changed from `.py` to `.ts`; test files renamed to `*.test.ts` convention
* Function names updated to camelCase (TypeScript convention): e.g., `handle_inbound` → `handleInbound`
* `store.py` now exports a TypeScript `Store` interface; implementations are `RedisStore` and `SqliteStore`
* `config.py` now exports a typed `Config` interface

### Replaced (dependency mapping)
* `fastapi` + `uvicorn` → `fastify`
* `httpx` → native `fetch` (Node 18 built-in) + `AbortController` for timeout
* `pytest` + `pytest-asyncio` → `jest` + `ts-jest`
* `python-dotenv` → `dotenv`
* `redis` (Python) → `redis` v4 (Node)
* `sqlite3` (Python built-in) → `better-sqlite3` (explicit dev dependency)
* `uuid` (Python built-in) → `crypto.randomUUID()` (Node built-in)
* `hmac` + `hashlib` (Python built-in) → `node:crypto` (Node built-in)
* FastAPI test client → Fastify `app.inject()` (built-in, no extra package)

### Notes
* All architecture, components, contracts, idempotency logic, rate limiting, and test coverage are unchanged
* Runtime dependency count unchanged: 4 packages (fastify, redis, better-sqlite3, dotenv)
* No new abstractions or patterns introduced

---

## [2026-03-18] — Documentation Reconciliation

### Added
* Created missing `docs/module-1-whatsapp/phase-3-technical-design.md` (v2 Final) — file was referenced in CHANGELOG but never written to disk

### Fixed
* `phase-1-module-definition.md` — logging `status` field updated to include full set: `received`, `duplicate`, `accepted`, `failed`, `throttled`, `rejected`, `timeout`, `timeout_unsafe`, `ignored` (was missing values added in Phase 2 v2 and Phase 3 v2)
* `phase-1-module-definition.md` — rate limiting section updated to describe two-tier approach (global + per-user) aligned with Phase 3 v2
* `phase-2-contract-design.md` — timeout section updated to distinguish `timeout` (safe) vs `timeout_unsafe` (idempotency write not complete) aligned with Phase 3 v2

### Notes
* Full audit performed across all 4 docs and CHANGELOG before Phase 5 approval
* All documents now consistent with each other and with approved design decisions

---

## [2026-03-18] — Module 1: Phase 4 — Refinements (v3)

### Updated
* `main.ts` — added raw body preservation requirement: `fastify-raw-body` plugin must be registered; raw `Buffer` required for HMAC verification; `JSON.stringify(parsedBody)` explicitly prohibited
* `handler.ts` — timeout enforcement defined as `Promise.race()` between pipeline and timer; `idempotencyWriteComplete` flag distinguishes `timeout` vs `timeout_unsafe`; `correlationId` auto-generated on outbound if caller omits it
* `validator.ts` — added note that `verifySignature` must receive raw `Buffer`, not re-serialized string
* `idempotency.ts` — clarified `"processing"` sentinel response (`cachedOutput: null`, HTTP 200, minimal duplicate response); added TTL-based recovery explanation for mid-write crash scenario
* `outbound.ts` — defined explicit fetch requirements: `AbortController` timeout, non-2xx explicit handling, safe `response.json()` with try/catch, no retry under any condition
* `store.ts` — added SQLite dev-only constraint: `better-sqlite3` is synchronous and blocks the event loop; production must use Redis
* `logger.ts` — added non-blocking logging constraint: no `console.log`, truncation before serialization, avoid heavy `JSON.stringify` on hot path

### Added
* `fastify-raw-body` added to `dependencies` in `package.json` block

### Notes
* No architecture, structure, or component changes — documentation refinements only
* All 7 requested refinements applied as targeted additions to existing component sections

---

## [2026-03-18] — Module 1: Phase 5 — Implementation

### Added
* Created `whatsapp-module/` — full production-ready implementation of the WhatsApp Interface Module
* `src/config.ts` — env loading with fail-fast validation, frozen Config object
* `src/logger.ts` — structured JSON logging with PII masking, payload truncation, log level filtering, non-blocking stdout emission
* `src/store.ts` — Store interface + RedisStore (redis v4) + SqliteStore (better-sqlite3, dev only) + createStore factory
* `src/validator.ts` — HMAC-SHA256 signature verification (timingSafeEqual), inbound payload validation, outbound request validation, E.164 regex
* `src/normalizer.ts` — WhatsApp raw payload → NormalizedMessage (snake_case, matches Phase 2 contract)
* `src/idempotency.ts` — SETNX atomic lock, "processing" sentinel handling, TTL-based recovery, graceful store degradation
* `src/rateLimiter.ts` — two-tier inbound (global + per-user) + outbound global rate limiting with fixed-window counter
* `src/outbound.ts` — WhatsApp Cloud API client with AbortController timeout, safe JSON parsing, explicit non-2xx handling, single-attempt (no retries)
* `src/handler.ts` — four route handlers; handleInbound implements Promise.race timeout with timeout_unsafe detection
* `src/main.ts` — Fastify app with fastify-raw-body plugin (raw Buffer for HMAC), dependency-injected buildApp(), production start()
* `tests/validator.test.ts` — 19 test cases
* `tests/normalizer.test.ts` — 10 test cases
* `tests/idempotency.test.ts` — 7 test cases
* `tests/rateLimiter.test.ts` — 10 test cases
* `tests/outbound.test.ts` — 8 test cases
* `tests/handler.test.ts` — 15 integration test cases using Fastify app.inject()
* `package.json`, `tsconfig.json`, `.env.example`, `README.md`

### Notes
* 101/101 tests passing across 6 test suites
* TypeScript strict mode: zero compiler errors (tsc --noEmit clean)
* better-sqlite3 pinned to ^11.x (v9 incompatible with Node.js 24 C++20 requirement)
* fastify-raw-body rawBody type declared as string | Buffer per plugin's own declaration
* One open handle warning from Jest (active timer in handler timeout tests) — does not affect test results

---

## [2026-03-18] — Module 1: Phase 5.1 — Implementation Hardening

### Fixed
* `src/handler.ts` — stored `setTimeout` reference in `timeoutHandle`; wrapped `Promise.race` in `try/finally` that always calls `clearTimeout(timeoutHandle)` — eliminates Jest open handle warning
* `src/validator.ts` — `verifySignature` signature updated to accept `Buffer | string`; added `Buffer.isBuffer()` guard before HMAC computation so raw body is always a Buffer regardless of plugin delivery type
* `src/store.ts` — added `process.once('SIGINT', shutdown)` and `process.once('SIGTERM', shutdown)` in `createStore` after Redis connect; `shutdown` calls `store.disconnect()` for graceful connection teardown
* `src/rateLimiter.ts` — added fixed-window strategy comment above `check()`: documents burst-at-boundary behavior

### Added
* `tests/handler.test.ts` — added `jest.clearAllTimers()` to `afterEach` alongside existing `app.close()` and `jest.restoreAllMocks()`
* `tests/rateLimiter.test.ts` — added top-level `afterEach(() => jest.clearAllTimers())` block

### Notes
* 101/101 tests passing — no regressions
* TypeScript strict mode: zero compiler errors (tsc --noEmit clean)
* Open handle warning fully eliminated — Jest exits cleanly with no warnings
* `outbound.ts` confirmed correct as-is: `clearTimeout` already called in both success and catch paths; `response.json()` already wrapped in try/catch

---

## [2026-03-20] — Ingestion Module: Discovery

### Added

* Full discovery audit of existing ingestion logic across the codebase
* Documented two parallel ingestion implementations: `flows/daily-reporting/src/server.ts` (inline traversal) and `modules/whatsapp/src/validator.ts` (production-grade validator)
* Identified `modules/whatsapp/src/validator.ts` and `modules/whatsapp/src/normalizer.ts` as extractable targets
* Confirmed `parser.ts`, `state.ts`, `handler.ts` in daily-reporting as flow-level concerns — not extractable

### Notes

* No code modified during discovery
* Extraction plan defined: ingestion-module as a wrapper layer over existing whatsapp module functions
* Rule established: do not extract from `server.ts`

---

## [2026-03-20] — Ingestion Module: Extraction Plan

### Added

* Defined `IngestionInput` type: source, provider, payload, rawBody (optional), headers (optional), secret (optional)
* Defined `NormalizedEvent` type per CLAUDE.md spec with `provider` field added
* Defined `IngestionResult` discriminated union: ok, signature_invalid, validation_failed, status_update, unsupported_type, adapter_error
* Defined `Adapter` interface: `execute(input: IngestionInput): Promise<IngestionResult>`
* Defined provider registry using `Map<string, Adapter>` — no if/else chains
* Defined MetaAdapter pipeline: sig verify (opt-in) → validate → type guard → normalize → map
* Mapped `NormalizedMessage` fields to `NormalizedEvent.metadata` fields

### Notes

* Zero changes to whatsapp module required
* Signature verification opt-in: all three of rawBody, headers, secret must be present for check to run
* Relative imports chosen over package references to avoid modifying whatsapp package.json

---

## [2026-03-20] — Ingestion Module: Implementation

### Added

* `modules/ingestion/src/types.ts` — IngestionInput, NormalizedEventMetadata, NormalizedEvent, IngestionResult, Adapter interface
* `modules/ingestion/src/registry.ts` — Map-based provider registry with registerAdapter and getAdapter
* `modules/ingestion/src/adapters/meta.ts` — MetaAdapter wrapping whatsapp/validator and whatsapp/normalizer via relative imports
* `modules/ingestion/src/index.ts` — public API: receive(), adapter registration at module init, type re-exports
* `modules/ingestion/tests/meta.adapter.test.ts` — 9 unit tests across 5 scenarios (valid message, signature failure, status update, unsupported type, validation failure)
* `modules/ingestion/package.json` — module package with jest/ts-jest configuration
* `modules/ingestion/tsconfig.json` — TypeScript config (no rootDir — cross-module relative imports)

### Notes

* Zero modifications to any pre-existing file
* `flows/daily-reporting` continues to work without adopting the new module
* `modules/whatsapp` validator and normalizer imported as-is — no logic copied

---

## [2026-03-20] — Ingestion Module: Targeted Fixes

### Updated

* `modules/ingestion/src/types.ts` — `NormalizedEventMetadata` relaxed: all fields made optional, renamed from snake_case to camelCase (messageId, correlationId, messageType, receivedAt, phoneNumberId), added `[key: string]: any` index signature for provider-specific extensions
* `modules/ingestion/src/types.ts` — `metadata` on `NormalizedEvent` changed from required to optional (`metadata?`)
* `modules/ingestion/src/adapters/meta.ts` — metadata construction updated to camelCase field names
* `modules/ingestion/src/index.ts` — both adapter_error catch blocks updated: `String(err)` → `err instanceof Error ? err.message : 'unknown error'`
* `modules/ingestion/tests/meta.adapter.test.ts` — metadata assertions updated to camelCase with optional chaining (`metadata?.messageId` etc.)

### Notes

* Tasks 1 (provider in NormalizedEvent) and 3 (provider in MetaAdapter) required no changes — already correctly implemented
* All 9 tests remain valid after field renaming
* No architectural changes

---

## [2026-03-20] — Ingestion Module: Documentation

### Added

* `docs/ingestion-module.md` — module documentation: purpose, architecture diagram, all interface definitions, MetaAdapter pipeline, field mapping table, usage example, dependency table, test coverage, backward compatibility statement
* `audits/ingestion-module.md` — extraction audit: files examined, changes made, five architecture decisions with rationale, risk assessment table, test coverage gaps, follow-up items
* Appended ingestion phase entries to `CHANGELOG.md`

---

## [2026-03-20] — Storage Module: Design + Implementation

### Added

* `modules/storage/src/types.ts` — `StorageInput` (provider, operation, resource, data?, query?, options?), `StorageResult<T>` discriminated union, `StorageAdapter` interface
* `modules/storage/src/registry.ts` — Map-based provider registry: `registerAdapter`, `getAdapter`
* `modules/storage/src/adapters/sheets.ts` — SheetsAdapter mapping: read→`read()`, write→`append()`, update→`update()`, query→`search()`; input guards for missing range/data/query; error code mapping from sheets result
* `modules/storage/src/index.ts` — public `execute()` with two try/catch layers; re-exports types; registers SheetsAdapter at init
* `modules/storage/tests/sheets.adapter.test.ts` — 23 test cases across all 4 operations + error paths; `sheets-module` fully mocked to prevent Google credential requirement
* `modules/storage/package.json` — `"sheets-module": "file:../sheets"` as runtime dependency
* `modules/storage/tsconfig.json` — standard config with `rootDir: "src"`
* `docs/storage-module.md` — module documentation

### Notes

* Zero modifications to `modules/sheets`
* `sheets-module` mocked via `jest.mock('sheets-module', ...)` in all tests
* 23/23 tests passing

---

## [2026-03-20] — Storage Module: Targeted Fixes

### Updated

* `modules/storage/src/types.ts` — `StorageInput.collection` renamed to `resource` (provider-agnostic naming); added `data?`, `query?`, `options?` fields; removed `value?` and `filter?`; `StorageResult` made generic (`StorageResult<T = any>`)
* `modules/storage/src/adapters/sheets.ts` — all field references updated: `resource` for sheetId, `options.range` for range, `data` for row data, `query` for filter; error shape mapped from `result.error.code` and `result.error.message`
* `modules/storage/src/index.ts` — removed `StorageData` and `StorageMetadata` re-exports (superseded by generic result)
* `modules/storage/tests/sheets.adapter.test.ts` — all test inputs updated to new field names; `BASE` uses `resource`; `options: { range }` pattern throughout

### Notes

* No architectural changes
* 23/23 tests remain passing after rename

---

## [2026-03-20] — AI Module: Design + Implementation

### Added

* `modules/ai/src/types.ts` — `Prompt`, `AIInput` (provider, task, input.text/data, options), `AIResult<T>` discriminated union, `AIAdapter` interface, `TaskHandler` interface, `TaskValidationResult`
* `modules/ai/src/registry.ts` — dual Map registry for adapters and task handlers: `registerAdapter`, `getAdapter`, `registerTask`, `getTask`
* `modules/ai/src/adapters/openai.ts` — OpenAI HTTP adapter: Node 18 `fetch`, `AbortController` (30s timeout), model `gpt-4o-mini`, temperature 0
* `modules/ai/src/tasks/classification.ts` — prompt with category list; validates label (string, in allowed categories), confidence (optional 0–1), reasoning (string)
* `modules/ai/src/tasks/extraction.ts` — prompt for named field extraction; validates all values are string or null; rejects empty result
* `modules/ai/src/tasks/qa.ts` — prompt embeds `options.question`; validates answer (string) and confidence (optional 0–1); instructs LLM to constrain answer to provided content
* `modules/ai/src/tasks/reasoning.ts` — prompt for step-by-step analysis; validates conclusion (string), steps (non-empty string array), confidence (optional 0–1)
* `modules/ai/src/utils/parser.ts` — self-contained three-stage JSON extractor (fence → substring → direct); no dependency on `ai-agent` module
* `modules/ai/src/pipeline.ts` — orchestrates: `getTask` → `getAdapter` → `buildPrompt` → `adapter.execute` → `parse` → `validate` → `AIResult`; never throws
* `modules/ai/src/index.ts` — registers OpenAI adapter (from `OPENAI_API_KEY` env) and all 4 task handlers at module init; exports `run()` and types
* `modules/ai/tests/pipeline.test.ts` — 9 test cases covering all 4 tasks (happy path) + unknown_task + unknown_provider + provider_error + parse_error + validation_error
* `modules/ai/package.json` — no runtime dependencies; dev: typescript, jest, ts-jest
* `modules/ai/tsconfig.json` — no rootDir (cross-module relative imports removed after parser was internalised)
* `docs/ai-module.md` — module documentation

### Notes

* `parse()` reused logic moved to `modules/ai/src/utils/parser.ts` — no dependency on `modules/ai-agent`
* 9/9 tests passing
* `modules/ai-agent` unchanged

---

## [2026-03-20] — AI Module: Targeted Fixes

### Updated

* `modules/ai/src/types.ts` — `AIAdapter.call` renamed to `AIAdapter.execute(prompt, options?)`; `Prompt.system` made optional; `AIInput.content: string` replaced with `AIInput.input: { text?: string; data?: unknown }` per CLAUDE.md spec
* `modules/ai/src/adapters/openai.ts` — method renamed `call` → `execute`
* `modules/ai/src/pipeline.ts` — `adapter.call(prompt)` → `adapter.execute(prompt)`; parser import updated from `../../ai-agent/src/parser` to `./utils/parser`
* `modules/ai/src/tasks/classification.ts` — `input.content` → `input.input.text ?? ''`; `confidence` validation made optional (guard only fires if value is present)
* `modules/ai/src/tasks/extraction.ts` — `input.content` → `input.input.text ?? ''`
* `modules/ai/src/tasks/qa.ts` — `input.content` → `input.input.text ?? ''`; `confidence` validation made optional
* `modules/ai/src/tasks/reasoning.ts` — `input.content` → `input.input.text ?? ''`; `confidence` validation made optional
* `modules/ai/tests/pipeline.test.ts` — mock paths updated from `../../ai-agent/src/parser` to `../src/utils/parser`; `AIInput.content` → `AIInput.input: { text }`; `{ call: jest.fn() }` → `{ execute: jest.fn() }`

### Notes

* 9/9 tests remain passing
* No architectural changes

---

## [2026-03-20] — Engine Module: Design + Implementation

### Added

* `modules/engine/src/types.ts` — `ExecutionContext` (namespaced: event, ai, storage, communication, state), `FlowStep` (id, type, input?, condition?), `Flow`, `StepResult` discriminated union, `ExecutionResult` discriminated union
* `modules/engine/src/stepExecutor.ts` — routes `step.type` to `ai-module.run`, `storage-module.execute`, or `communication-module.execute`; all calls wrapped in try/catch; never throws
* `modules/engine/src/runner.ts` — sequential loop: evaluates condition (skip if false), calls `executeStep`, fails fast on first failure, writes output to `context.{type}[step.id]`
* `modules/engine/src/index.ts` — exports `runFlow` and all types
* `modules/engine/tests/runner.test.ts` — 5 test cases: sequential execution with context accumulation, conditional skip, fail-fast, provider exception, initial context passthrough
* `modules/engine/package.json` — `file:` dependencies on `ai-module`, `storage-module`, `communication-module`
* `modules/engine/tsconfig.json` — standard config with `rootDir: "src"`
* `docs/engine-module.md` — module documentation

### Notes

* All three module dependencies fully mocked in tests
* 5/5 tests passing
* No existing module modified

---

## [2026-03-20] — Engine Module: Targeted Fixes

### Updated

* `modules/engine/src/types.ts` — `ExecutionContext` changed from `Record<string, unknown>` to structured namespaced type (`event?`, `ai?`, `storage?`, `communication?`, `state?`); `FlowStep.module` renamed to `FlowStep.type`; `FlowStep.outputKey` removed (output storage is now automatic by type + step id); `FlowStep.input` made optional (defaults to `{}`)
* `modules/engine/src/stepExecutor.ts` — `step.module` → `step.type` throughout; `OkAIResult` updated to `{ ok: true; result: { output: unknown } }` (CLAUDE.md spec shape); AI result extraction updated from `res.output` → `res.result.output`; `sendMessage` import replaced with namespace import `* as communicationModule`; communication case updated from `sendMessage(to, message)` to `communicationModule.execute(rawInput)`; input guard added: `step.input ? step.input(context) : {}`
* `modules/engine/src/runner.ts` — `context[step.outputKey] = output` replaced with explicit namespace writes: `context.ai[step.id]`, `context.storage[step.id]`, `context.communication[step.id]`
* `modules/engine/tests/runner.test.ts` — all `module:` → `type:`; `outputKey` removed from step definitions; context access updated to namespaced keys (`ctx.storage?.['fetch-data']`); AI mock return updated to `{ ok: true, result: { output: ... } }`; communication mock updated from `sendMessage` to `execute`; initial context test uses `state: { phone, body }` pattern

### Notes

* 5/5 tests remain passing
* No architectural changes
