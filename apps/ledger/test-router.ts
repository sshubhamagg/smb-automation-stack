/**
 * Intent Router Integration Tests
 *
 * Section A — Structured mode
 *   Tests buildInitialContext + resolveRouting (pure logic, no I/O)
 *   Then E2E through intentRouterFlow with mocked communication
 *
 * Section B — AI mode
 *   Intelligence module is mocked with predetermined responses
 *   Tests classify-intent + extract-transaction step paths
 *   Then verifies resolveRouting produces correct decisions
 */

import 'dotenv/config';
import { runFlow } from 'engine-module';
import type { Modules, ExecutionContext } from 'engine-module';

import {
  buildInitialContext,
  intentRouterFlow,
  resolveRouting,
} from '../../flows/ledger/intent-router/flow';
import type { RouterConfig, RouterPayload, RoutingDecision } from '../../flows/ledger/intent-router/flow';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let section = '';

function startSection(name: string): void {
  section = name;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('─'.repeat(60));
}

function assert(label: string, condition: boolean, detail?: string): void {
  const tag = condition ? 'PASS' : 'FAIL';
  const prefix = condition ? '  ✓' : '  ✗';
  console.log(`${prefix}  ${label}`);
  if (!condition && detail) console.log(`       → ${detail}`);
  condition ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// Mocked modules
// ---------------------------------------------------------------------------

// Communication — captures messages, never sends
const sentMessages: { to: string; message: string }[] = [];
const mockComm = async (input: unknown) => {
  const { to, message } = input as { to: string; message: string };
  sentMessages.push({ to, message });
  return { ok: true as const, output: null };
};

// AI mock — returns deterministic responses keyed by test message
type MockAIResponse = { task: string; output: Record<string, unknown> };
const AI_MOCK_TABLE: Record<string, MockAIResponse[]> = {
  'i received 5000 from rahul': [
    { task: 'classification', output: { label: 'add',     confidence: 0.96, reasoning: 'money received' } },
    { task: 'extraction',     output: { fields: { type: 'received', amount: '5000', party: 'rahul', category: null } } },
  ],
  "what's my balance?": [
    { task: 'classification', output: { label: 'balance', confidence: 0.98, reasoning: 'balance query' } },
  ],
  "show me today's transactions": [
    { task: 'classification', output: { label: 'summary', confidence: 0.95, reasoning: 'daily summary' } },
  ],
  'ledger for rahul': [
    { task: 'classification', output: { label: 'ledger',  confidence: 0.92, reasoning: 'party ledger' } },
  ],
  'remove my last transaction': [
    { task: 'classification', output: { label: 'delete',  confidence: 0.97, reasoning: 'delete request' } },
  ],
  'i paid 800 to electricity': [
    { task: 'classification', output: { label: 'add',     confidence: 0.94, reasoning: 'payment made' } },
    { task: 'extraction',     output: { fields: { type: 'paid', amount: '800', party: 'electricity', category: 'utilities' } } },
  ],
  'gave 1.5k to grocery shop': [
    { task: 'classification', output: { label: 'add',     confidence: 0.91, reasoning: 'payment' } },
    { task: 'extraction',     output: { fields: { type: 'gave', amount: '1.5k', party: 'grocery shop', category: null } } },
  ],
  'got 3k from sharma for project': [
    { task: 'classification', output: { label: 'add',     confidence: 0.93, reasoning: 'payment received' } },
    { task: 'extraction',     output: { fields: { type: 'got', amount: '3k', party: 'sharma', category: 'project' } } },
  ],
};

function buildMockIntelligence(msgKey: string): (input: unknown) => Promise<{ ok: true; task: string; output: unknown }> {
  const responses = AI_MOCK_TABLE[msgKey] ?? [];
  let callIndex   = 0;
  return async (input: unknown) => {
    const { task } = input as { task: string };
    const resp = responses[callIndex++];
    if (!resp || resp.task !== task) {
      return { ok: true as const, task, output: { label: 'balance', fields: {} } };
    }
    return { ok: true as const, task: resp.task, output: resp.output };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER   = '+917017875169';
const OWNER_PHONE = '+917017875169';

const STRUCTURED_CONFIG: RouterConfig = { mode: 'structured', aiProvider: 'anthropic', ownerPhone: OWNER_PHONE };
const AI_CONFIG:         RouterConfig = { mode: 'ai',         aiProvider: 'anthropic', ownerPhone: OWNER_PHONE };

function buildStructuredModules(): Modules {
  return { communication: mockComm };
}

function buildAIModules(msgKey: string): Modules {
  return {
    communication: mockComm,
    intelligence:  buildMockIntelligence(msgKey) as Modules['intelligence'],
  };
}

async function runRouter(
  message: string,
  config: RouterConfig,
  modules: Modules,
): Promise<{ routing: RoutingDecision; ctx: ExecutionContext }> {
  const ctx    = buildInitialContext({ message, user: TEST_USER }, config);
  const result = await runFlow(intentRouterFlow, ctx, modules);
  const finalCtx = result.ok ? result.context : ctx;
  return { routing: resolveRouting(finalCtx), ctx: finalCtx };
}

function checkPayload(
  routing: RoutingDecision,
  expectedFlow: string,
  checks: Partial<RouterPayload>,
): void {
  assert(`routes to ${expectedFlow}`, routing?.nextFlow === expectedFlow, `got ${routing?.nextFlow ?? 'null'}`);
  if (!routing) return;
  for (const [k, v] of Object.entries(checks)) {
    const actual = (routing.payload as Record<string, unknown>)[k];
    assert(`payload.${k} = ${String(v)}`, actual === v, `got ${String(actual)}`);
  }
}

// ============================================================
// SECTION A — Structured Mode
// ============================================================

async function testStructuredBalance(): Promise<void> {
  const { routing } = await runRouter('balance', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-balance', { command: 'balance', user: TEST_USER });
}

async function testStructuredSummary(): Promise<void> {
  const { routing } = await runRouter('summary today', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-summary', { command: 'summary', user: TEST_USER });
}

async function testStructuredDeleteLast(): Promise<void> {
  const { routing } = await runRouter('delete last', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-delete', { command: 'delete', user: TEST_USER });
}

async function testStructuredLedgerParty(): Promise<void> {
  const { routing } = await runRouter('ledger rahul', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-party', { command: 'ledger', party: 'rahul' });
}

async function testStructuredAddCredit(): Promise<void> {
  const { routing } = await runRouter('add credit 5000 rahul', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { command: 'add', type: 'credit', amount: 5000, party: 'rahul' });
}

async function testStructuredAddDebitWithCategory(): Promise<void> {
  const { routing } = await runRouter('add debit 1200 groceries food', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { type: 'debit', amount: 1200, party: 'groceries', category: 'food' });
}

async function testStructuredAmountShorthand5k(): Promise<void> {
  const { routing } = await runRouter('add credit 5k sharma', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { amount: 5000, party: 'sharma' });
}

async function testStructuredAmountShorthand1point5k(): Promise<void> {
  const { routing } = await runRouter('add debit 1.5k rent', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { amount: 1500, party: 'rent' });
}

async function testStructuredTypeAliasReceived(): Promise<void> {
  const { routing } = await runRouter('add received 3000 rahul', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { type: 'credit', amount: 3000, party: 'rahul' });
}

async function testStructuredTypeAliasPaid(): Promise<void> {
  const { routing } = await runRouter('add paid 500 electricity', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { type: 'debit', amount: 500, party: 'electricity' });
}

async function testStructuredDefaultCategoryDebit(): Promise<void> {
  const { routing } = await runRouter('add debit 200 shop', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { category: 'expense' });
}

async function testStructuredDefaultCategoryCredit(): Promise<void> {
  const { routing } = await runRouter('add credit 200 sharma', STRUCTURED_CONFIG, buildStructuredModules());
  checkPayload(routing, 'ledger-entry', { category: 'income' });
}

async function testStructuredInvalidUnknownCommand(): Promise<void> {
  sentMessages.length = 0;
  const modules = buildStructuredModules();
  const ctx     = buildInitialContext({ message: 'hello world', user: TEST_USER }, STRUCTURED_CONFIG);
  const result  = await runFlow(intentRouterFlow, ctx, modules);
  assert('flow completes ok',         result.ok);
  assert('send-invalid fired',        sentMessages.length === 1, `sent ${sentMessages.length} messages`);
  assert('message contains "Invalid"',sentMessages[0]?.message.includes('Invalid'));
  assert('routing is null',           resolveRouting(result.ok ? result.context : ctx) === null);
}

async function testStructuredInvalidMissingAmount(): Promise<void> {
  const ctx    = buildInitialContext({ message: 'add credit rahul', user: TEST_USER }, STRUCTURED_CONFIG);
  const state  = ctx.state as Record<string, unknown>;
  assert('validInput = false', state['validInput'] === false);
  assert('structured = null',  state['structured'] === null);
  assert('needsAI = false',    state['needsAI'] === false);
}

async function testStructuredInvalidMissingParty(): Promise<void> {
  const ctx   = buildInitialContext({ message: 'add debit 500', user: TEST_USER }, STRUCTURED_CONFIG);
  const state = ctx.state as Record<string, unknown>;
  assert('validInput = false', state['validInput'] === false);
}

async function testStructuredInvalidBadType(): Promise<void> {
  const ctx   = buildInitialContext({ message: 'add transfer 500 rahul', user: TEST_USER }, STRUCTURED_CONFIG);
  const state = ctx.state as Record<string, unknown>;
  assert('validInput = false', state['validInput'] === false);
}

async function testStructuredCaseInsensitive(): Promise<void> {
  const { routing: r1 } = await runRouter('BALANCE', STRUCTURED_CONFIG, buildStructuredModules());
  const { routing: r2 } = await runRouter('DELETE LAST', STRUCTURED_CONFIG, buildStructuredModules());
  assert('BALANCE routes to ledger-balance', r1?.nextFlow === 'ledger-balance');
  assert('DELETE LAST routes to ledger-delete', r2?.nextFlow === 'ledger-delete');
}

// ============================================================
// SECTION B — AI Mode
// ============================================================

async function testAIReceivedMoney(): Promise<void> {
  const msg     = 'i received 5000 from rahul';
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  checkPayload(routing, 'ledger-entry', { type: 'credit', amount: 5000, party: 'rahul' });
}

async function testAIBalanceQuery(): Promise<void> {
  const msg     = "what's my balance?";
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  checkPayload(routing, 'ledger-balance', { command: 'balance' });
}

async function testAISummaryQuery(): Promise<void> {
  const msg     = "show me today's transactions";
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  checkPayload(routing, 'ledger-summary', { command: 'summary' });
}

async function testAIDeleteRequest(): Promise<void> {
  const msg     = 'remove my last transaction';
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  checkPayload(routing, 'ledger-delete', { command: 'delete' });
}

async function testAIPaidDebit(): Promise<void> {
  const msg     = 'i paid 800 to electricity';
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  checkPayload(routing, 'ledger-entry', { type: 'debit', amount: 800, party: 'electricity', category: 'utilities' });
}

async function testAIAmountShorthandInNaturalLanguage(): Promise<void> {
  const msg     = 'gave 1.5k to grocery shop';
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  // 'gave' → debit, '1.5k' → 1500
  checkPayload(routing, 'ledger-entry', { type: 'debit', amount: 1500, party: 'grocery shop' });
}

async function testAIGotPaymentWithCategory(): Promise<void> {
  const msg     = 'got 3k from sharma for project';
  const modules = buildAIModules(msg);
  const { routing } = await runRouter(msg, AI_CONFIG, modules);
  checkPayload(routing, 'ledger-entry', { type: 'credit', amount: 3000, party: 'sharma', category: 'project' });
}

async function testAIBypassesAIForStructuredCommands(): Promise<void> {
  // Even in AI mode, a structured command should bypass AI (needsAI = false)
  const ctx   = buildInitialContext({ message: 'balance', user: TEST_USER }, AI_CONFIG);
  const state = ctx.state as Record<string, unknown>;
  assert('needsAI = false for structured command in AI mode', state['needsAI'] === false);
  assert('structured is set',                                  state['structured'] !== null);
}

async function testAIClassifyStepSkippedForStructured(): Promise<void> {
  // Run router in AI mode with a structured command — classify-intent must be skipped
  const modules = buildAIModules('balance'); // mock won't be called
  const ctx     = buildInitialContext({ message: 'add credit 1000 rahul', user: TEST_USER }, AI_CONFIG);
  const result  = await runFlow(intentRouterFlow, ctx, modules);
  assert('flow ok', result.ok);
  const steps   = result.ok ? result.steps : [];
  const classify = steps.find(s => s.id === 'classify-intent');
  assert('classify-intent skipped', classify?.status === 'skipped', `status: ${classify?.status}`);
}

async function testAILedgerPartyFromNaturalLanguage(): Promise<void> {
  // "ledger for rahul" starts with "ledger " so structured detection wins — AI is bypassed.
  // party = "for rahul" (includes the preposition — known limitation of prefix-only parsing).
  const msg     = 'ledger for rahul';
  const modules = buildAIModules(msg);
  const ctx     = buildInitialContext({ message: msg, user: TEST_USER }, AI_CONFIG);
  const state   = ctx.state as Record<string, unknown>;
  assert('structured detection wins (needsAI = false)', state['needsAI'] === false);
  assert('structured is set',                           state['structured'] !== null);

  const result  = await runFlow(intentRouterFlow, ctx, modules);
  assert('flow ok', result.ok);
  const steps    = result.ok ? result.steps : [];
  const classify = steps.find(s => s.id === 'classify-intent');
  assert('classify-intent skipped (AI bypassed)', classify?.status === 'skipped');

  const routing = resolveRouting(result.ok ? result.context : ctx);
  assert('routes to ledger-party', routing?.nextFlow === 'ledger-party');
  assert('party extracted as "for rahul"', routing?.payload?.party === 'for rahul');
  console.log('       Note: natural-language ledger phrasing matches "ledger <party>" prefix rule.');
  console.log(`       party captured: "${routing?.payload?.party}" — use "ledger rahul" for clean results.`);
}

// ============================================================
// SECTION C — Step execution trace
// ============================================================

async function testStructuredStepTrace(): Promise<void> {
  const modules = buildStructuredModules();
  const ctx     = buildInitialContext({ message: 'add debit 500 shop', user: TEST_USER }, STRUCTURED_CONFIG);
  const result  = await runFlow(intentRouterFlow, ctx, modules);
  assert('flow ok', result.ok);
  const steps = result.ok ? result.steps : [];
  assert('classify-intent skipped',    steps.find(s => s.id === 'classify-intent')?.status   === 'skipped');
  assert('extract-transaction skipped',steps.find(s => s.id === 'extract-transaction')?.status === 'skipped');
  assert('send-invalid skipped',       steps.find(s => s.id === 'send-invalid')?.status       === 'skipped');
  console.log(`       steps: ${steps.map(s => `${s.id}:${s.status}`).join(', ')}`);
}

async function testAIStepTrace(): Promise<void> {
  const msg     = 'i received 5000 from rahul';
  const modules = buildAIModules(msg);
  const ctx     = buildInitialContext({ message: msg, user: TEST_USER }, AI_CONFIG);
  const result  = await runFlow(intentRouterFlow, ctx, modules);
  assert('flow ok', result.ok);
  const steps = result.ok ? result.steps : [];
  assert('classify-intent ran',         steps.find(s => s.id === 'classify-intent')?.status   === 'ok');
  assert('extract-transaction ran',     steps.find(s => s.id === 'extract-transaction')?.status === 'ok');
  assert('send-invalid skipped',        steps.find(s => s.id === 'send-invalid')?.status       === 'skipped');
  console.log(`       steps: ${steps.map(s => `${s.id}:${s.status}`).join(', ')}`);
}

async function testAIBalanceStepTrace(): Promise<void> {
  const msg     = "what's my balance?";
  const modules = buildAIModules(msg);
  const ctx     = buildInitialContext({ message: msg, user: TEST_USER }, AI_CONFIG);
  const result  = await runFlow(intentRouterFlow, ctx, modules);
  assert('flow ok', result.ok);
  const steps = result.ok ? result.steps : [];
  assert('classify-intent ran',         steps.find(s => s.id === 'classify-intent')?.status   === 'ok');
  assert('extract-transaction skipped', steps.find(s => s.id === 'extract-transaction')?.status === 'skipped');
  console.log(`       steps: ${steps.map(s => `${s.id}:${s.status}`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\nIntent Router — Integration Tests');
  console.log('Mode A: Structured  |  Mode B: AI (mocked)');

  // ── Section A: Structured mode ──────────────────────────────────────────
  startSection('A1 · Structured — Command routing');
  await testStructuredBalance();
  await testStructuredSummary();
  await testStructuredDeleteLast();
  await testStructuredLedgerParty();

  startSection('A2 · Structured — Add command variants');
  await testStructuredAddCredit();
  await testStructuredAddDebitWithCategory();
  await testStructuredAmountShorthand5k();
  await testStructuredAmountShorthand1point5k();
  await testStructuredTypeAliasReceived();
  await testStructuredTypeAliasPaid();
  await testStructuredDefaultCategoryDebit();
  await testStructuredDefaultCategoryCredit();

  startSection('A3 · Structured — Invalid inputs');
  await testStructuredInvalidUnknownCommand();
  await testStructuredInvalidMissingAmount();
  await testStructuredInvalidMissingParty();
  await testStructuredInvalidBadType();

  startSection('A4 · Structured — Edge cases');
  await testStructuredCaseInsensitive();

  // ── Section B: AI mode ─────────────────────────────────────────────────
  startSection('B1 · AI — Natural language routing');
  await testAIReceivedMoney();
  await testAIBalanceQuery();
  await testAISummaryQuery();
  await testAIDeleteRequest();

  startSection('B2 · AI — Natural language add extraction');
  await testAIPaidDebit();
  await testAIAmountShorthandInNaturalLanguage();
  await testAIGotPaymentWithCategory();

  startSection('B3 · AI — Bypass & optimisation');
  await testAIBypassesAIForStructuredCommands();
  await testAIClassifyStepSkippedForStructured();
  await testAILedgerPartyFromNaturalLanguage();

  // ── Section C: Step execution traces ───────────────────────────────────
  startSection('C1 · Step execution traces');
  await testStructuredStepTrace();
  await testAIStepTrace();
  await testAIBalanceStepTrace();

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
