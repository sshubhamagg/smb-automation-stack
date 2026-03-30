/**
 * Integration test suite — Field Sales Automation
 *
 * Covers four scenarios end-to-end using real logic (parser, validator,
 * buildInitialContext, computeMissing, aggregateReports, flow steps) with
 * only storage and communication modules mocked at the executor boundary.
 *
 * No internal function is mocked. The engine runner runs real flow logic.
 */

import { buildInitialContext } from '../src/context';
import { dailyReportEntryFlow } from '../../../flows/field-sales/daily-report-entry/flow';
import { missingReportEscalationFlow } from '../../../flows/field-sales/missing-report-escalation/flow';
import { runFlow } from '../../../modules/engine/src/runner';
import type { Modules } from '../../../modules/engine/src/types';
import type { Rep, NormalizedReport } from '../src/types';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const REP: Rep = {
  rep_id: 'rep-01',
  name: 'Arjun Mehta',
  manager_id: 'mgr-01',
  region: 'Jaipur',
  phone: '+919876543210',
  active: true,
};

const REP_2: Rep = {
  rep_id: 'rep-02',
  name: 'Priya Sharma',
  manager_id: 'mgr-01',
  region: 'Jaipur',
  phone: '+919876543211',
  active: true,
};

const DATE = '25 Mar';

const VALID_MESSAGE = `date: ${DATE}
region: Jaipur
beat: Sodala
calls: 18
orders: 7
sales_value: 24500
stock_issue: no
remarks: all good`;

const CONFIG = { reps: [REP, REP_2] };

function makeReport(rep_id: string, overrides: Partial<NormalizedReport> = {}): NormalizedReport {
  return {
    report_id: `${rep_id}_${DATE}`,
    rep_id,
    date: DATE,
    region: 'Jaipur',
    beat: 'Sodala',
    total_calls: 18,
    orders: 7,
    sales_value: 24500,
    stock_issue: false,
    remarks: '',
    status: 'valid',
    submitted_at: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module mock factories
// ---------------------------------------------------------------------------

type Call = Record<string, unknown>;

function makeStorage(
  queryRows: NormalizedReport[] = [],
  writeResponse: { ok: boolean; output?: unknown; error?: string } = { ok: true, output: { written: true } },
): { mock: jest.Mock; calls: Call[] } {
  const calls: Call[] = [];
  const mock = jest.fn().mockImplementation((input: unknown) => {
    const op = input as Call;
    calls.push(op);
    if (op['operation'] === 'query') {
      return Promise.resolve({ ok: true, output: { rows: queryRows } });
    }
    return Promise.resolve(writeResponse);
  });
  return { mock, calls };
}

function makeComm(): { mock: jest.Mock; messages: { to: string; message: string }[] } {
  const messages: { to: string; message: string }[] = [];
  const mock = jest.fn().mockImplementation((input: unknown) => {
    messages.push(input as { to: string; message: string });
    return Promise.resolve({ ok: true, output: null });
  });
  return { mock, messages };
}

function modules(storage: jest.Mock, communication: jest.Mock): Modules {
  return { storage, communication };
}

// ---------------------------------------------------------------------------
// Scenario 1 — Valid input
// ---------------------------------------------------------------------------

describe('Scenario 1: valid input', () => {
  let storage: ReturnType<typeof makeStorage>;
  let comm: ReturnType<typeof makeComm>;
  let stepStatuses: Record<string, string>;

  beforeAll(async () => {
    storage = makeStorage([]); // no existing record
    comm    = makeComm();

    const ctx = buildInitialContext({ event: { message: VALID_MESSAGE, user: REP.phone }, config: CONFIG });
    if (!ctx.ok) throw new Error(`context: ${ctx.error}`);

    const result = await runFlow(dailyReportEntryFlow, ctx.context, modules(storage.mock, comm.mock));
    if (!result.ok) throw new Error(`flow: ${result.error}`);

    stepStatuses = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
  });

  // Context
  it('buildInitialContext succeeds', () => {
    const ctx = buildInitialContext({ event: { message: VALID_MESSAGE, user: REP.phone }, config: CONFIG });
    expect(ctx.ok).toBe(true);
  });

  // Step execution
  it('check-duplicate runs', ()          => expect(stepStatuses['check-duplicate']).toBe('ok'));
  it('write-raw-report runs', ()         => expect(stepStatuses['write-raw-report']).toBe('ok'));
  it('write-normalized-report runs', ()  => expect(stepStatuses['write-normalized-report']).toBe('ok'));
  it('send-confirmation runs', ()        => expect(stepStatuses['send-confirmation']).toBe('ok'));
  it('send-error is skipped', ()         => expect(stepStatuses['send-error']).toBe('skipped'));

  // Storage writes
  it('storage is called 3 times (query + 2 writes)', () => {
    expect(storage.mock).toHaveBeenCalledTimes(3);
  });

  it('check-duplicate queries daily_reports with correct rep_id and date', () => {
    const queryCall = storage.calls.find((c) => c['operation'] === 'query');
    expect(queryCall?.['resource']).toBe('daily_reports');
    expect((queryCall?.['query'] as Record<string, string>)['rep_id']).toBe(REP.rep_id);
    expect((queryCall?.['query'] as Record<string, string>)['date']).toBe(DATE);
  });

  it('raw report is written to raw_reports with rep_id and source', () => {
    const write = storage.calls.find((c) => c['resource'] === 'raw_reports');
    const data = write?.['data'] as Record<string, unknown>;
    expect(data?.['rep_id']).toBe(REP.rep_id);
    expect(data?.['source']).toBe('whatsapp');
  });

  it('normalized report is written to daily_reports with status "valid"', () => {
    const write = storage.calls.find((c) => c['resource'] === 'daily_reports' && c['operation'] === 'write');
    const data = write?.['data'] as Record<string, unknown>;
    expect(data?.['status']).toBe('valid');
    expect(data?.['rep_id']).toBe(REP.rep_id);
    expect(data?.['report_id']).toBe(`${REP.rep_id}_${DATE}`);
  });

  it('normalized report carries correct numeric fields', () => {
    const write = storage.calls.find((c) => c['resource'] === 'daily_reports' && c['operation'] === 'write');
    const data = write?.['data'] as Record<string, unknown>;
    expect(data?.['total_calls']).toBe(18);
    expect(data?.['orders']).toBe(7);
    expect(data?.['sales_value']).toBe(24500);
  });

  // Messages
  it('exactly one message is sent', () => {
    expect(comm.messages).toHaveLength(1);
  });

  it('confirmation is sent to rep phone', () => {
    expect(comm.messages[0].to).toBe(REP.phone);
  });

  it('confirmation message mentions the date', () => {
    expect(comm.messages[0].message).toContain(DATE);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Invalid input
// ---------------------------------------------------------------------------

describe('Scenario 2: invalid input', () => {

  describe('2a — malformed message (missing fields)', () => {
    it('buildInitialContext returns error', () => {
      const result = buildInitialContext({
        event: { message: 'just some text', user: REP.phone },
        config: CONFIG,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/parse failed/i);
    });

    it('flow is never reached', async () => {
      const storage = makeStorage();
      const comm    = makeComm();
      const ctx = buildInitialContext({
        event: { message: 'bad input', user: REP.phone },
        config: CONFIG,
      });
      expect(ctx.ok).toBe(false);
      // Would call runFlow here — but ctx.ok is false so we don't
      expect(storage.mock).not.toHaveBeenCalled();
      expect(comm.mock).not.toHaveBeenCalled();
    });
  });

  describe('2b — unknown rep', () => {
    it('buildInitialContext returns error for unregistered phone', () => {
      const result = buildInitialContext({
        event: { message: VALID_MESSAGE, user: '+910000000000' },
        config: CONFIG,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/unknown or inactive rep/i);
    });

    it('buildInitialContext returns error for inactive rep', () => {
      const inactiveRep = { ...REP, active: false };
      const result = buildInitialContext({
        event: { message: VALID_MESSAGE, user: REP.phone },
        config: { reps: [inactiveRep] },
      });
      expect(result.ok).toBe(false);
    });
  });

  describe('2c — region mismatch', () => {
    it('buildInitialContext returns validation error', () => {
      const wrongRegion = VALID_MESSAGE.replace('region: Jaipur', 'region: Mumbai');
      const result = buildInitialContext({
        event: { message: wrongRegion, user: REP.phone },
        config: CONFIG,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/validation failed/i);
    });
  });

  describe('2d — negative numeric field', () => {
    it('buildInitialContext returns parse error for negative sales_value', () => {
      const badMsg = VALID_MESSAGE.replace('sales_value: 24500', 'sales_value: -100');
      const result = buildInitialContext({
        event: { message: badMsg, user: REP.phone },
        config: CONFIG,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/parse failed/i);
    });
  });

  describe('2e — invalid date', () => {
    it('buildInitialContext returns validation error for impossible date', () => {
      const badDate = VALID_MESSAGE.replace(`date: ${DATE}`, 'date: 31 Apr');
      const result = buildInitialContext({
        event: { message: badDate, user: REP.phone },
        config: CONFIG,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/validation failed/i);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Duplicate input
// ---------------------------------------------------------------------------

describe('Scenario 3: duplicate input', () => {
  let storage: ReturnType<typeof makeStorage>;
  let comm: ReturnType<typeof makeComm>;
  let stepStatuses: Record<string, string>;

  beforeAll(async () => {
    // Pre-populate: report for rep-01 on DATE already exists
    storage = makeStorage([makeReport(REP.rep_id)]);
    comm    = makeComm();

    const ctx = buildInitialContext({ event: { message: VALID_MESSAGE, user: REP.phone }, config: CONFIG });
    if (!ctx.ok) throw new Error(`context: ${ctx.error}`);

    const result = await runFlow(dailyReportEntryFlow, ctx.context, modules(storage.mock, comm.mock));
    if (!result.ok) throw new Error(`flow: ${result.error}`);

    stepStatuses = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
  });

  // Flow still completes ok
  it('flow completes ok (duplicate is not a failure)', async () => {
    const ctx = buildInitialContext({ event: { message: VALID_MESSAGE, user: REP.phone }, config: CONFIG });
    if (!ctx.ok) throw new Error(ctx.error);
    const result = await runFlow(
      dailyReportEntryFlow,
      ctx.context,
      modules(makeStorage([makeReport(REP.rep_id)]).mock, makeComm().mock),
    );
    expect(result.ok).toBe(true);
  });

  // Step execution
  it('check-duplicate runs', ()              => expect(stepStatuses['check-duplicate']).toBe('ok'));
  it('write-raw-report runs (audit trail)', () => expect(stepStatuses['write-raw-report']).toBe('ok'));
  it('write-normalized-report is skipped', () => expect(stepStatuses['write-normalized-report']).toBe('skipped'));
  it('send-confirmation is skipped', ()       => expect(stepStatuses['send-confirmation']).toBe('skipped'));
  it('send-error runs', ()                    => expect(stepStatuses['send-error']).toBe('ok'));

  // Storage writes
  it('storage is called twice (query + raw write only)', () => {
    expect(storage.mock).toHaveBeenCalledTimes(2);
  });

  it('normalized report is NOT written to daily_reports', () => {
    const normalizedWrite = storage.calls.find(
      (c) => c['resource'] === 'daily_reports' && c['operation'] === 'write',
    );
    expect(normalizedWrite).toBeUndefined();
  });

  it('raw report IS written (audit trail preserved)', () => {
    const rawWrite = storage.calls.find((c) => c['resource'] === 'raw_reports');
    expect(rawWrite).toBeDefined();
  });

  // Messages
  it('exactly one message is sent', () => {
    expect(comm.messages).toHaveLength(1);
  });

  it('duplicate warning is sent to rep phone', () => {
    expect(comm.messages[0].to).toBe(REP.phone);
  });

  it('duplicate warning message contains "duplicate"', () => {
    expect(comm.messages[0].message.toLowerCase()).toContain('duplicate');
  });

  it('duplicate warning mentions the submitted date', () => {
    expect(comm.messages[0].message).toContain(DATE);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Missing report escalation
// ---------------------------------------------------------------------------

describe('Scenario 4: missing report scenario', () => {
  const ESCALATION_CONFIG = {
    date: DATE,
    manager_phone: '+910000000001',
    team_broadcast_phone: '+910000000002',
  };

  describe('4a — one rep missing', () => {
    let storage: ReturnType<typeof makeStorage>;
    let comm: ReturnType<typeof makeComm>;
    let stepStatuses: Record<string, string>;

    beforeAll(async () => {
      // rep-01 submitted; rep-02 has not
      const reports = [makeReport(REP.rep_id)];
      const allReps = [REP, REP_2];

      storage = makeStorage();
      storage.mock.mockImplementation((input: unknown) => {
        const op = input as Call;
        if ((op['resource'] as string) === 'reps') {
          return Promise.resolve({ ok: true, output: { rows: allReps } });
        }
        return Promise.resolve({ ok: true, output: { rows: reports } });
      });
      comm = makeComm();

      const ctx = {
        state: {
          config: { ...ESCALATION_CONFIG, reps: allReps },
        },
      };

      const result = await runFlow(missingReportEscalationFlow, ctx, modules(storage.mock, comm.mock));
      if (!result.ok) throw new Error(`flow: ${result.error}`);
      stepStatuses = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
    });

    it('read-reps runs', ()     => expect(stepStatuses['read-reps']).toBe('ok'));
    it('read-reports runs', ()  => expect(stepStatuses['read-reports']).toBe('ok'));
    it('notify-reps runs', ()   => expect(stepStatuses['notify-reps']).toBe('ok'));
    it('notify-manager runs', () => expect(stepStatuses['notify-manager']).toBe('ok'));

    it('two messages are sent (reps + manager)', () => {
      expect(comm.messages).toHaveLength(2);
    });

    it('first message goes to team broadcast phone', () => {
      expect(comm.messages[0].to).toBe(ESCALATION_CONFIG.team_broadcast_phone);
    });

    it('second message goes to manager phone', () => {
      expect(comm.messages[1].to).toBe(ESCALATION_CONFIG.manager_phone);
    });

    it('manager message names the missing rep', () => {
      expect(comm.messages[1].message).toContain(REP_2.name);
    });

    it('manager message does not name the rep who submitted', () => {
      expect(comm.messages[1].message).not.toContain(REP.name);
    });

    it('manager message includes the date', () => {
      expect(comm.messages[1].message).toContain(DATE);
    });
  });

  describe('4b — all reps submitted, no escalation', () => {
    it('notify steps are skipped when no one is missing', async () => {
      const reports = [makeReport(REP.rep_id), makeReport(REP_2.rep_id)];
      const allReps = [REP, REP_2];

      const storageMock = jest.fn().mockImplementation((input: unknown) => {
        const op = input as Call;
        if ((op['resource'] as string) === 'reps') {
          return Promise.resolve({ ok: true, output: { rows: allReps } });
        }
        return Promise.resolve({ ok: true, output: { rows: reports } });
      });
      const commMock = makeComm();

      const result = await runFlow(
        missingReportEscalationFlow,
        { state: { config: { ...ESCALATION_CONFIG, reps: allReps } } },
        modules(storageMock, commMock.mock),
      );

      if (!result.ok) throw new Error(result.error);
      const statuses = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
      expect(statuses['notify-reps']).toBe('skipped');
      expect(statuses['notify-manager']).toBe('skipped');
      expect(commMock.messages).toHaveLength(0);
    });
  });

  describe('4c — inactive rep excluded from missing list', () => {
    it('inactive rep is not treated as missing', async () => {
      const inactiveRep2 = { ...REP_2, active: false };
      const reports      = [makeReport(REP.rep_id)]; // only REP submitted; REP_2 inactive
      const allReps      = [REP, inactiveRep2];

      const storageMock = jest.fn().mockImplementation((input: unknown) => {
        const op = input as Call;
        if ((op['resource'] as string) === 'reps') {
          return Promise.resolve({ ok: true, output: { rows: allReps } });
        }
        return Promise.resolve({ ok: true, output: { rows: reports } });
      });
      const commMock = makeComm();

      const result = await runFlow(
        missingReportEscalationFlow,
        { state: { config: { ...ESCALATION_CONFIG, reps: allReps } } },
        modules(storageMock, commMock.mock),
      );

      if (!result.ok) throw new Error(result.error);
      const statuses = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
      expect(statuses['notify-reps']).toBe('skipped');
      expect(statuses['notify-manager']).toBe('skipped');
    });
  });
});
