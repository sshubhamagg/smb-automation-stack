import { missingReportEscalationFlow } from '../../../../flows/field-sales/missing-report-escalation/flow';
import { runFlow } from '../../../../modules/engine/src/runner';
import type { ExecutionContext, Modules } from '../../../../modules/engine/src/types';
import type { Rep, NormalizedReport } from '../../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATE = '25 Mar';

const CONFIG = {
  date: DATE,
  manager_phone: '+910000000001',
  team_broadcast_phone: '+910000000002',
};

function makeRep(rep_id: string, name: string, active = true): Rep {
  return { rep_id, name, manager_id: 'mgr-01', region: 'Jaipur', phone: `+91${rep_id}`, active };
}

function makeReport(rep_id: string): NormalizedReport {
  return {
    report_id: `${rep_id}_${DATE}`,
    rep_id,
    date: DATE,
    region: 'Jaipur',
    beat: 'Sodala',
    total_calls: 10,
    orders: 2,
    sales_value: 5000,
    stock_issue: false,
    remarks: '',
    status: 'valid',
    submitted_at: 0,
  };
}

const REPS = [makeRep('r1', 'Arjun'), makeRep('r2', 'Priya'), makeRep('r3', 'Karan')];

function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return { state: { config: CONFIG }, ...overrides };
}

// ---------------------------------------------------------------------------
// Module mock builders
// ---------------------------------------------------------------------------

function makeStorage(reps: Rep[], reports: NormalizedReport[]): jest.Mock {
  return jest.fn().mockImplementation((input: unknown) => {
    const { resource } = input as Record<string, string>;
    if (resource === 'reps') return Promise.resolve({ ok: true, output: { rows: reps } });
    if (resource === 'daily_reports') return Promise.resolve({ ok: true, output: { rows: reports } });
    return Promise.resolve({ ok: false, error: `unknown resource: ${resource}` });
  });
}

function makeCommunication(): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: true, output: null });
}

function stepsById(steps: { id: string; status: string }[]) {
  return Object.fromEntries(steps.map((s) => [s.id, s.status]));
}

// ---------------------------------------------------------------------------
// Happy path — some reps missing
// ---------------------------------------------------------------------------

describe('missing-report-escalation — reps missing', () => {
  let storage: jest.Mock;
  let communication: jest.Mock;
  let modules: Modules;

  beforeEach(() => {
    // r1 submitted; r2 and r3 are missing
    storage = makeStorage(REPS, [makeReport('r1')]);
    communication = makeCommunication();
    modules = { storage, communication };
  });

  it('flow completes successfully', async () => {
    const result = await runFlow(missingReportEscalationFlow, makeContext(), modules);
    expect(result.ok).toBe(true);
  });

  it('all four steps run when there are missing reps', async () => {
    const result = await runFlow(missingReportEscalationFlow, makeContext(), modules);
    if (!result.ok) throw new Error(result.error);
    const status = stepsById(result.steps);
    expect(status['read-reps']).toBe('ok');
    expect(status['read-reports']).toBe('ok');
    expect(status['notify-reps']).toBe('ok');
    expect(status['notify-manager']).toBe('ok');
  });

  it('storage is called twice (one read per resource)', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    expect(storage).toHaveBeenCalledTimes(2);
  });

  it('communication is called twice (reps + manager)', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    expect(communication).toHaveBeenCalledTimes(2);
  });

  it('notify-reps sends to team_broadcast_phone', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const firstCall = communication.mock.calls[0][0] as Record<string, string>;
    expect(firstCall.to).toBe(CONFIG.team_broadcast_phone);
  });

  it('notify-manager sends to manager_phone', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const secondCall = communication.mock.calls[1][0] as Record<string, string>;
    expect(secondCall.to).toBe(CONFIG.manager_phone);
  });

  it('notify-reps message mentions the target date', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const firstCall = communication.mock.calls[0][0] as Record<string, string>;
    expect(firstCall.message).toContain(DATE);
  });

  it('notify-manager message includes the count of missing reps', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const secondCall = communication.mock.calls[1][0] as Record<string, string>;
    expect(secondCall.message).toContain('2');
  });

  it('notify-manager message includes missing rep names', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const secondCall = communication.mock.calls[1][0] as Record<string, string>;
    expect(secondCall.message).toContain('Priya');
    expect(secondCall.message).toContain('Karan');
  });

  it('notify-reps message does not mention the rep who submitted', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const firstCall = communication.mock.calls[0][0] as Record<string, string>;
    expect(firstCall.message).not.toContain('Arjun');
  });

  it('read-reports queries for the configured date', async () => {
    await runFlow(missingReportEscalationFlow, makeContext(), modules);
    const reportQuery = storage.mock.calls[1][0] as Record<string, unknown>;
    expect((reportQuery.query as Record<string, string>).date).toBe(DATE);
  });
});

// ---------------------------------------------------------------------------
// All reps submitted — notifications skipped
// ---------------------------------------------------------------------------

describe('missing-report-escalation — no missing reps', () => {
  it('skips both notify steps when all reps have submitted', async () => {
    const storage = makeStorage(REPS, REPS.map((r) => makeReport(r.rep_id)));
    const communication = makeCommunication();
    const result = await runFlow(missingReportEscalationFlow, makeContext(), { storage, communication });
    if (!result.ok) throw new Error(result.error);

    const status = stepsById(result.steps);
    expect(status['notify-reps']).toBe('skipped');
    expect(status['notify-manager']).toBe('skipped');
    expect(communication).not.toHaveBeenCalled();
  });

  it('flow still returns ok when all reps submitted', async () => {
    const storage = makeStorage(REPS, REPS.map((r) => makeReport(r.rep_id)));
    const result = await runFlow(missingReportEscalationFlow, makeContext(), { storage, communication: makeCommunication() });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No reps at all — nothing to escalate
// ---------------------------------------------------------------------------

describe('missing-report-escalation — empty roster', () => {
  it('skips notify steps when roster is empty', async () => {
    const storage = makeStorage([], []);
    const communication = makeCommunication();
    const result = await runFlow(missingReportEscalationFlow, makeContext(), { storage, communication });
    if (!result.ok) throw new Error(result.error);

    const status = stepsById(result.steps);
    expect(status['notify-reps']).toBe('skipped');
    expect(status['notify-manager']).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Storage failure — flow stops
// ---------------------------------------------------------------------------

describe('missing-report-escalation — storage failure', () => {
  it('stops at read-reps if storage fails', async () => {
    const storage = jest.fn().mockResolvedValue({ ok: false, error: 'sheets unreachable' });
    const communication = makeCommunication();
    const result = await runFlow(missingReportEscalationFlow, makeContext(), { storage, communication });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedStep).toBe('read-reps');
    expect(communication).not.toHaveBeenCalled();
  });

  it('stops at read-reports if second storage call fails', async () => {
    const storage = jest.fn()
      .mockResolvedValueOnce({ ok: true, output: { rows: REPS } })
      .mockResolvedValueOnce({ ok: false, error: 'query failed' });
    const communication = makeCommunication();
    const result = await runFlow(missingReportEscalationFlow, makeContext(), { storage, communication });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedStep).toBe('read-reports');
    expect(communication).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Input/condition safety — must not throw on sparse context
// ---------------------------------------------------------------------------

describe('missing-report-escalation — safety', () => {
  it('conditions do not throw when outputs are absent', () => {
    const ctx: ExecutionContext = { state: { config: CONFIG } };
    for (const step of missingReportEscalationFlow.steps) {
      if (step.condition) {
        expect(() => step.condition!(ctx)).not.toThrow();
      }
    }
  });

  it('input() functions do not throw when state and outputs are missing', () => {
    const sparseCtx: ExecutionContext = { state: {} };
    for (const step of missingReportEscalationFlow.steps) {
      if (step.input) {
        expect(() => step.input!(sparseCtx)).not.toThrow();
      }
    }
  });

  it('conditions return false (not throw) when outputs are undefined', () => {
    const ctx: ExecutionContext = { state: { config: CONFIG } };
    for (const step of missingReportEscalationFlow.steps) {
      if (step.condition) {
        const result = step.condition(ctx);
        expect(typeof result).toBe('boolean');
      }
    }
  });
});
