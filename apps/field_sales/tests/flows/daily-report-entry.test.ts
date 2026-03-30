import { dailyReportEntryFlow } from '../../../../flows/field-sales/daily-report-entry/flow';
import { runFlow } from '../../../../modules/engine/src/runner';
import type { ExecutionContext, Modules } from '../../../../modules/engine/src/types';
import type { Rep } from '../../src/types';
import type { ParsedReportData } from '../../src/parser';

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

const PARSED: ParsedReportData = {
  date: '25 Mar',
  region: 'Jaipur',
  beat: 'Sodala',
  total_calls: 18,
  orders: 7,
  sales_value: 24500,
  stock_issue: false,
  remarks: 'all good',
};

function makeContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    event: { message: 'raw whatsapp text', user: REP.phone },
    state: { parsed_input: PARSED, rep: REP },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module mock builders
// ---------------------------------------------------------------------------

type MockModuleResult = { ok: true; output: unknown } | { ok: false; error: string };

function makeStorage(
  queryResponse: { rows: unknown[] },
  writeResponse: MockModuleResult = { ok: true, output: { written: true } },
): jest.Mock {
  return jest.fn().mockImplementation((input: unknown) => {
    const op = (input as Record<string, string>).operation;
    if (op === 'query') return Promise.resolve({ ok: true, output: queryResponse });
    return Promise.resolve(writeResponse);
  });
}

function makeCommunication(
  response: MockModuleResult = { ok: true, output: { sent: true } },
): jest.Mock {
  return jest.fn().mockResolvedValue(response);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepsById(steps: { id: string; status: string }[]) {
  return Object.fromEntries(steps.map((s) => [s.id, s.status]));
}

// ---------------------------------------------------------------------------
// Happy path — no duplicate
// ---------------------------------------------------------------------------

describe('daily-report-entry — no duplicate (valid submission)', () => {
  let storage: jest.Mock;
  let communication: jest.Mock;
  let modules: Modules;

  beforeEach(() => {
    storage = makeStorage({ rows: [] });   // no existing record
    communication = makeCommunication();
    modules = { storage, communication };
  });

  it('flow completes successfully', async () => {
    const result = await runFlow(dailyReportEntryFlow, makeContext(), modules);
    expect(result.ok).toBe(true);
  });

  it('runs all non-error steps and skips send-error', async () => {
    const result = await runFlow(dailyReportEntryFlow, makeContext(), modules);
    if (!result.ok) throw new Error(result.error);

    const status = stepsById(result.steps);
    expect(status['check-duplicate']).toBe('ok');
    expect(status['write-raw-report']).toBe('ok');
    expect(status['write-normalized-report']).toBe('ok');
    expect(status['send-confirmation']).toBe('ok');
    expect(status['send-error']).toBe('skipped');
  });

  it('storage is called three times (query + 2 writes)', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    expect(storage).toHaveBeenCalledTimes(3);
  });

  it('communication is called once (confirmation only)', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    expect(communication).toHaveBeenCalledTimes(1);
  });

  it('check-duplicate queries daily_reports with rep_id and date', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    const queryCall = storage.mock.calls[0][0] as Record<string, unknown>;
    expect(queryCall.operation).toBe('query');
    expect(queryCall.resource).toBe('daily_reports');
    expect(queryCall.query).toEqual({ rep_id: REP.rep_id, date: PARSED.date });
  });

  it('write-raw-report writes to raw_reports with correct shape', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    const rawWriteCall = storage.mock.calls[1][0] as Record<string, unknown>;
    expect(rawWriteCall.operation).toBe('write');
    expect(rawWriteCall.resource).toBe('raw_reports');
    const data = rawWriteCall.data as Record<string, unknown>;
    expect(data.rep_id).toBe(REP.rep_id);
    expect(data.source).toBe('whatsapp');
  });

  it('write-normalized-report includes a composite report_id', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    const normWriteCall = storage.mock.calls[2][0] as Record<string, unknown>;
    const data = normWriteCall.data as Record<string, unknown>;
    expect(data.report_id).toBe(`${REP.rep_id}_${PARSED.date}`);
    expect(data.status).toBe('valid');
  });

  it('send-confirmation is sent to rep phone', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    const commCall = communication.mock.calls[0][0] as Record<string, unknown>;
    expect(commCall.to).toBe(REP.phone);
    expect(typeof commCall.message).toBe('string');
    expect((commCall.message as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Duplicate path
// ---------------------------------------------------------------------------

describe('daily-report-entry — duplicate detected', () => {
  let storage: jest.Mock;
  let communication: jest.Mock;
  let modules: Modules;

  beforeEach(() => {
    storage = makeStorage({ rows: [{ rep_id: REP.rep_id, date: PARSED.date }] });
    communication = makeCommunication();
    modules = { storage, communication };
  });

  it('flow completes successfully (duplicate is not a flow failure)', async () => {
    const result = await runFlow(dailyReportEntryFlow, makeContext(), modules);
    expect(result.ok).toBe(true);
  });

  it('skips write-normalized-report and send-confirmation; runs send-error', async () => {
    const result = await runFlow(dailyReportEntryFlow, makeContext(), modules);
    if (!result.ok) throw new Error(result.error);

    const status = stepsById(result.steps);
    expect(status['check-duplicate']).toBe('ok');
    expect(status['write-raw-report']).toBe('ok');
    expect(status['write-normalized-report']).toBe('skipped');
    expect(status['send-confirmation']).toBe('skipped');
    expect(status['send-error']).toBe('ok');
  });

  it('storage is called twice (query + raw write only)', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    expect(storage).toHaveBeenCalledTimes(2);
  });

  it('send-error is sent to rep phone with a meaningful message', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    const commCall = communication.mock.calls[0][0] as Record<string, unknown>;
    expect(commCall.to).toBe(REP.phone);
    expect((commCall.message as string).toLowerCase()).toMatch(/duplicate/);
  });

  it('send-error message mentions the submitted date', async () => {
    await runFlow(dailyReportEntryFlow, makeContext(), modules);
    const commCall = communication.mock.calls[0][0] as Record<string, unknown>;
    expect(commCall.message as string).toContain(PARSED.date);
  });
});

// ---------------------------------------------------------------------------
// Failure handling — storage module fails
// ---------------------------------------------------------------------------

describe('daily-report-entry — module failures', () => {
  it('stops at check-duplicate if storage fails', async () => {
    const storage = jest.fn().mockResolvedValue({ ok: false, error: 'sheets unreachable' });
    const communication = makeCommunication();
    const result = await runFlow(dailyReportEntryFlow, makeContext(), { storage, communication });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedStep).toBe('check-duplicate');
    }
    expect(communication).not.toHaveBeenCalled();
  });

  it('stops at write-raw-report if raw write fails', async () => {
    const storage = jest.fn().mockImplementation((input: unknown) => {
      const op = (input as Record<string, string>).operation;
      if (op === 'query') return Promise.resolve({ ok: true, output: { rows: [] } });
      return Promise.resolve({ ok: false, error: 'write failed' });
    });
    const communication = makeCommunication();
    const result = await runFlow(dailyReportEntryFlow, makeContext(), { storage, communication });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedStep).toBe('write-raw-report');
  });
});

// ---------------------------------------------------------------------------
// Input safety — condition and input must not throw on sparse context
// ---------------------------------------------------------------------------

describe('daily-report-entry — input/condition safety', () => {
  it('conditions do not throw when ctx.outputs is undefined', () => {
    const ctx: ExecutionContext = { state: { parsed_input: PARSED, rep: REP } };
    for (const step of dailyReportEntryFlow.steps) {
      if (step.condition) {
        expect(() => step.condition!(ctx)).not.toThrow();
      }
    }
  });

  it('input() functions do not throw when state fields are missing', () => {
    const sparseCtx: ExecutionContext = { state: {} };
    for (const step of dailyReportEntryFlow.steps) {
      if (step.input) {
        expect(() => step.input!(sparseCtx)).not.toThrow();
      }
    }
  });
});
