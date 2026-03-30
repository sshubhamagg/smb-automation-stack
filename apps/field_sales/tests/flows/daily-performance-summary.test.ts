import { dailyPerformanceSummaryFlow } from '../../../../flows/field-sales/daily-performance-summary/flow';
import { runFlow } from '../../../../modules/engine/src/runner';
import type { ExecutionContext, Modules } from '../../../../modules/engine/src/types';
import type { Rep, NormalizedReport } from '../../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATE = '25 Mar';

function makeRep(rep_id: string, name: string, active = true): Rep {
  return { rep_id, name, manager_id: 'mgr-01', region: 'Jaipur', phone: `+91${rep_id}`, active };
}

const REPS = [
  makeRep('r1', 'Arjun'),
  makeRep('r2', 'Priya'),
  makeRep('r3', 'Karan'),
];

const CONFIG = {
  date: DATE,
  manager_id: 'mgr-01',
  manager_phone: '+910000000001',
  reps: REPS,
};

function makeReport(
  rep_id: string,
  overrides: Partial<NormalizedReport> = {},
): NormalizedReport {
  return {
    report_id: `${rep_id}_${DATE}`,
    rep_id,
    date: DATE,
    region: 'Jaipur',
    beat: 'Sodala',
    total_calls: 10,
    orders: 2,
    sales_value: 1000,
    stock_issue: false,
    remarks: '',
    status: 'valid',
    submitted_at: 0,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return { state: { config: CONFIG }, ...overrides };
}

function makeStorage(reports: NormalizedReport[]): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: true, output: { rows: reports } });
}

function makeCommunication(): jest.Mock {
  return jest.fn().mockResolvedValue({ ok: true, output: null });
}

function getSentMessage(communication: jest.Mock): string {
  return (communication.mock.calls[0][0] as Record<string, string>).message;
}

function getSentTo(communication: jest.Mock): string {
  return (communication.mock.calls[0][0] as Record<string, string>).to;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

describe('daily-performance-summary — flow execution', () => {
  it('completes successfully with valid reports', async () => {
    const reports = REPS.map((r) => makeReport(r.rep_id));
    const modules: Modules = { storage: makeStorage(reports), communication: makeCommunication() };
    const result = await runFlow(dailyPerformanceSummaryFlow, makeContext(), modules);
    expect(result.ok).toBe(true);
  });

  it('always runs both steps', async () => {
    const modules: Modules = { storage: makeStorage([]), communication: makeCommunication() };
    const result = await runFlow(dailyPerformanceSummaryFlow, makeContext(), modules);
    if (!result.ok) throw new Error(result.error);
    const statuses = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
    expect(statuses['read-reports']).toBe('ok');
    expect(statuses['send-summary']).toBe('ok');
  });

  it('queries daily_reports for the configured date', async () => {
    const storage = makeStorage([]);
    const result = await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage, communication: makeCommunication() });
    if (!result.ok) throw new Error(result.error);
    const queryCall = storage.mock.calls[0][0] as Record<string, unknown>;
    expect(queryCall.resource).toBe('daily_reports');
    expect((queryCall.query as Record<string, string>).date).toBe(DATE);
  });

  it('sends summary to manager_phone', async () => {
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage([]), communication });
    expect(getSentTo(communication)).toBe(CONFIG.manager_phone);
  });

  it('stops if storage fails', async () => {
    const storage = jest.fn().mockResolvedValue({ ok: false, error: 'sheets down' });
    const communication = makeCommunication();
    const result = await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage, communication });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedStep).toBe('read-reports');
    expect(communication).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Summary message content
// ---------------------------------------------------------------------------

describe('daily-performance-summary — message content', () => {
  it('includes the date', async () => {
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), {
      storage: makeStorage([makeReport('r1')]),
      communication,
    });
    expect(getSentMessage(communication)).toContain(DATE);
  });

  it('includes manager_id', async () => {
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), {
      storage: makeStorage([makeReport('r1')]),
      communication,
    });
    expect(getSentMessage(communication)).toContain(CONFIG.manager_id);
  });

  it('shows correct reps assigned count', async () => {
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), {
      storage: makeStorage([makeReport('r1')]),
      communication,
    });
    expect(getSentMessage(communication)).toContain('3'); // 3 active reps
  });

  it('shows reports received count', async () => {
    const reports = [makeReport('r1'), makeReport('r2')];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    expect(getSentMessage(communication)).toContain('2');
  });

  it('names missing reps in the message', async () => {
    const reports = [makeReport('r1')]; // r2 and r3 missing
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    const msg = getSentMessage(communication);
    expect(msg).toContain('Priya');
    expect(msg).toContain('Karan');
  });

  it('shows "none" for missing when all reps submitted', async () => {
    const reports = REPS.map((r) => makeReport(r.rep_id));
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    expect(getSentMessage(communication)).toContain('none');
  });

  it('includes aggregated totals', async () => {
    const reports = [
      makeReport('r1', { sales_value: 10000, orders: 5, total_calls: 20 }),
      makeReport('r2', { sales_value: 8000, orders: 3, total_calls: 15 }),
    ];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    const msg = getSentMessage(communication);
    expect(msg).toContain('18000');
    expect(msg).toContain('8');
    expect(msg).toContain('35');
  });

  it('lists top performers sorted by sales descending', async () => {
    const reports = [
      makeReport('r1', { sales_value: 5000 }),
      makeReport('r2', { sales_value: 15000 }),
      makeReport('r3', { sales_value: 10000 }),
    ];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    const msg = getSentMessage(communication);
    const topIdx = msg.indexOf('Top performers');
    const priyaIdx = msg.indexOf('Priya');   // r2 — 15000
    const karanIdx = msg.indexOf('Karan');   // r3 — 10000
    const arjunIdx = msg.indexOf('Arjun');   // r1 — 5000
    expect(priyaIdx).toBeGreaterThan(topIdx);
    expect(priyaIdx).toBeLessThan(karanIdx);
    expect(karanIdx).toBeLessThan(arjunIdx);
  });
});

// ---------------------------------------------------------------------------
// Exception detection
// ---------------------------------------------------------------------------

describe('daily-performance-summary — exceptions', () => {
  it('includes exception section when a rep has zero sales', async () => {
    const reports = [makeReport('r1', { sales_value: 0 })];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    const msg = getSentMessage(communication);
    expect(msg).toContain('Exceptions');
    expect(msg).toContain('zero sales');
    expect(msg).toContain('Arjun');
  });

  it('includes exception section when a rep reports stock issue', async () => {
    const reports = [makeReport('r1', { stock_issue: true })];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    const msg = getSentMessage(communication);
    expect(msg).toContain('Exceptions');
    expect(msg).toContain('stock issue');
  });

  it('omits exception section when no exceptions exist', async () => {
    const reports = [makeReport('r1', { sales_value: 5000, stock_issue: false })];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    expect(getSentMessage(communication)).not.toContain('Exceptions');
  });

  it('does not count invalid reports as exceptions', async () => {
    const reports = [makeReport('r1', { sales_value: 0, status: 'invalid' })];
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), { storage: makeStorage(reports), communication });
    expect(getSentMessage(communication)).not.toContain('Exceptions');
  });
});

// ---------------------------------------------------------------------------
// Input/condition safety
// ---------------------------------------------------------------------------

describe('daily-performance-summary — safety', () => {
  it('input() functions do not throw on sparse context', () => {
    const sparseCtx: ExecutionContext = { state: {} };
    for (const step of dailyPerformanceSummaryFlow.steps) {
      if (step.input) {
        expect(() => step.input!(sparseCtx)).not.toThrow();
      }
    }
  });

  it('produces a message even when reports list is empty', async () => {
    const communication = makeCommunication();
    await runFlow(dailyPerformanceSummaryFlow, makeContext(), {
      storage: makeStorage([]),
      communication,
    });
    const msg = getSentMessage(communication);
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('message is deterministic — same input produces same output', async () => {
    const reports = [
      makeReport('r1', { sales_value: 5000 }),
      makeReport('r2', { sales_value: 3000 }),
    ];

    const run = async () => {
      const communication = makeCommunication();
      await runFlow(dailyPerformanceSummaryFlow, makeContext(), {
        storage: makeStorage(reports),
        communication,
      });
      return getSentMessage(communication);
    };

    const [msg1, msg2] = await Promise.all([run(), run()]);
    expect(msg1).toBe(msg2);
  });
});
