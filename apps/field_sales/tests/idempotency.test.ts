/**
 * Idempotency test: submitting the same event twice must not produce
 * duplicate normalized writes. The second submission is detected by the
 * check-duplicate step and routed to send-error instead.
 *
 * No external dependencies — storage and communication are simulated
 * in-memory. The test owns the state between the two runs.
 */

import { buildInitialContext } from '../src/context';
import { dailyReportEntryFlow } from '../../../flows/field-sales/daily-report-entry/flow';
import { runFlow } from '../../../modules/engine/src/runner';
import type { Modules, ExecutionContext } from '../../../modules/engine/src/types';
import type { Rep } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REP: Rep = {
  rep_id: 'rep-01',
  name: 'Arjun Mehta',
  manager_id: 'mgr-01',
  region: 'Jaipur',
  phone: '+919876543210',
  active: true,
};

const EVENT_MESSAGE = `date: 25 Mar
region: Jaipur
beat: Sodala
calls: 18
orders: 7
sales_value: 24500
stock_issue: no
remarks: all good`;

const EVENT = {
  message: EVENT_MESSAGE,
  user: REP.phone,
};

const CONFIG = { reps: [REP] };

// ---------------------------------------------------------------------------
// In-memory storage simulation
// Tracks write calls keyed by (rep_id + date) to enforce duplicate detection.
// ---------------------------------------------------------------------------

type StoredReport = { rep_id: string; date: string; [key: string]: unknown };

function makeInMemoryStorage() {
  const rawWrites: unknown[]         = [];
  const normalizedWrites: StoredReport[] = [];

  const execute = jest.fn().mockImplementation((input: unknown) => {
    const op = (input as Record<string, unknown>);

    if (op['operation'] === 'query' && op['resource'] === 'daily_reports') {
      const query = op['query'] as { rep_id: string; date: string };
      const rows = normalizedWrites.filter(
        (r) => r.rep_id === query.rep_id && r.date === query.date,
      );
      return Promise.resolve({ ok: true, output: { rows } });
    }

    if (op['operation'] === 'write' && op['resource'] === 'raw_reports') {
      rawWrites.push(op['data']);
      return Promise.resolve({ ok: true, output: { written: true } });
    }

    if (op['operation'] === 'write' && op['resource'] === 'daily_reports') {
      normalizedWrites.push(op['data'] as StoredReport);
      return Promise.resolve({ ok: true, output: { written: true } });
    }

    return Promise.resolve({ ok: false, error: `unhandled: ${op['operation']} on ${op['resource']}` });
  });

  return { execute, rawWrites, normalizedWrites };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModules(storage: ReturnType<typeof makeInMemoryStorage>['execute']): Modules {
  const communication = jest.fn().mockResolvedValue({ ok: true, output: null });
  return {
    storage: (input: unknown) => storage(input),
    communication: (input: unknown) => communication(input as { to: string; message: string }),
    _communication: communication,
  } as unknown as Modules & { _communication: jest.Mock };
}

function getSentMessages(modules: Modules & { _communication?: jest.Mock }): string[] {
  const comm = (modules as Record<string, unknown>)['_communication'] as jest.Mock | undefined;
  return (comm?.mock.calls ?? []).map((c) => (c[0] as { message: string }).message);
}

async function submitEvent(
  modules: Modules,
  storage: ReturnType<typeof makeInMemoryStorage>['execute'],
): Promise<{ ok: boolean; steps: { id: string; status: string }[] }> {
  const ctxResult = buildInitialContext({ event: EVENT, config: CONFIG });
  if (!ctxResult.ok) throw new Error(`buildInitialContext failed: ${ctxResult.error}`);

  const result = await runFlow(dailyReportEntryFlow, ctxResult.context, modules);
  return {
    ok: result.ok,
    steps: result.steps.map((s) => ({ id: s.id, status: s.status })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('idempotency — same event submitted twice', () => {
  let store: ReturnType<typeof makeInMemoryStorage>;
  let modules: Modules;
  let firstResult:  Awaited<ReturnType<typeof submitEvent>>;
  let secondResult: Awaited<ReturnType<typeof submitEvent>>;

  beforeAll(async () => {
    store   = makeInMemoryStorage();
    modules = buildModules(store.execute);

    firstResult  = await submitEvent(modules, store.execute);
    secondResult = await submitEvent(modules, store.execute);
  });

  // ── Both runs succeed (duplicate is not a flow error) ───────────────────

  it('first submission completes ok', () => {
    expect(firstResult.ok).toBe(true);
  });

  it('second submission also completes ok', () => {
    expect(secondResult.ok).toBe(true);
  });

  // ── Normalized write fires exactly once ─────────────────────────────────

  it('normalized report is written exactly once', () => {
    expect(store.normalizedWrites).toHaveLength(1);
  });

  it('normalized write has the correct rep_id and date', () => {
    expect(store.normalizedWrites[0].rep_id).toBe(REP.rep_id);
    expect(store.normalizedWrites[0].date).toBe('25 Mar');
  });

  // ── Raw write fires on every submission (audit trail) ───────────────────

  it('raw report is written on both submissions', () => {
    expect(store.rawWrites).toHaveLength(2);
  });

  // ── Step execution maps differ between runs ──────────────────────────────

  it('first run: write-normalized-report is ok', () => {
    const step = firstResult.steps.find((s) => s.id === 'write-normalized-report');
    expect(step?.status).toBe('ok');
  });

  it('second run: write-normalized-report is skipped', () => {
    const step = secondResult.steps.find((s) => s.id === 'write-normalized-report');
    expect(step?.status).toBe('skipped');
  });

  it('first run: send-confirmation is ok', () => {
    const step = firstResult.steps.find((s) => s.id === 'send-confirmation');
    expect(step?.status).toBe('ok');
  });

  it('second run: send-confirmation is skipped', () => {
    const step = secondResult.steps.find((s) => s.id === 'send-confirmation');
    expect(step?.status).toBe('skipped');
  });

  it('first run: send-error is skipped', () => {
    const step = firstResult.steps.find((s) => s.id === 'send-error');
    expect(step?.status).toBe('skipped');
  });

  it('second run: send-error is ok', () => {
    const step = secondResult.steps.find((s) => s.id === 'send-error');
    expect(step?.status).toBe('ok');
  });

  // ── Messages sent reflect the routing decision ───────────────────────────

  it('first run sends a confirmation message', () => {
    const messages = getSentMessages(modules);
    expect(messages[0]).toMatch(/received|recorded/i);
  });

  it('second run sends a duplicate warning', () => {
    const messages = getSentMessages(modules);
    expect(messages[1]).toMatch(/duplicate/i);
  });

  it('exactly two messages are sent across both runs', () => {
    expect(getSentMessages(modules)).toHaveLength(2);
  });

  // ── Running a third time still does not write again ──────────────────────

  it('normalized write count stays at 1 after a third submission', async () => {
    await submitEvent(modules, store.execute);
    expect(store.normalizedWrites).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Separate scenario: context is rebuilt identically each time
// ---------------------------------------------------------------------------

describe('idempotency — buildInitialContext is deterministic', () => {
  it('produces identical context state for the same event', () => {
    const r1 = buildInitialContext({ event: EVENT, config: CONFIG });
    const r2 = buildInitialContext({ event: EVENT, config: CONFIG });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    const s1 = r1.context.state as Record<string, unknown>;
    const s2 = r2.context.state as Record<string, unknown>;

    expect(s1['parsed_input']).toEqual(s2['parsed_input']);
    expect((s1['rep'] as Rep).rep_id).toBe((s2['rep'] as Rep).rep_id);
  });
});
