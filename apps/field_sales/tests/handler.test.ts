// ---------------------------------------------------------------------------
// Mock all I/O boundaries before importing the handler.
// Order matters: jest.mock() is hoisted by babel-jest / ts-jest.
// ---------------------------------------------------------------------------

jest.mock('../../../modules/storage/src/index', () => ({
  execute: jest.fn(),
}));

jest.mock('../../../modules/communication/src/main', () => ({
  execute: jest.fn(),
}));

jest.mock('../../../modules/engine/src/runner', () => ({
  runFlow: jest.fn(),
}));

import { handleFieldSalesReport } from '../src/handler';
import type { FieldSalesEvent } from '../src/handler';

import { execute as storageExecute } from '../../../modules/storage/src/index';
import { execute as communicationExecute } from '../../../modules/communication/src/main';
import { runFlow } from '../../../modules/engine/src/runner';
import type { StepResult } from '../../../modules/engine/src/types';
import type { ExecutionContext } from '../../../modules/engine/src/types';

const mockStorage = storageExecute as jest.Mock;
const mockComm = communicationExecute as jest.Mock;
const mockRunFlow = runFlow as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_MESSAGE = `date: 25 Mar
region: Jaipur
beat: Sodala
calls: 18
orders: 7
sales_value: 24500
stock_issue: no
remarks: all good`;

const REPS = [
  {
    rep_id: 'rep-01',
    name: 'Arjun Mehta',
    manager_id: 'mgr-01',
    region: 'Jaipur',
    phone: '+919876543210',
    active: true,
  },
];

const VALID_EVENT: FieldSalesEvent = {
  message: VALID_MESSAGE,
  user: '+919876543210',
  timestamp: 1711353600000,
};

function makeFlowOk(steps: Partial<StepResult>[] = []): ReturnType<typeof mockRunFlow> {
  const ctx: ExecutionContext = { state: {}, outputs: {} };
  return Promise.resolve({
    ok: true,
    context: ctx,
    steps: steps.length > 0 ? steps : [
      { id: 'check-duplicate',        status: 'ok',      output: { rows: [] } },
      { id: 'write-raw-report',       status: 'ok',      output: {} },
      { id: 'write-normalized-report',status: 'ok',      output: {} },
      { id: 'send-confirmation',      status: 'ok',      output: null },
      { id: 'send-error',             status: 'skipped'              },
    ],
  });
}

function makeFlowFail(failedStep: string, error: string): ReturnType<typeof mockRunFlow> {
  const ctx: ExecutionContext = { state: {}, outputs: {} };
  return Promise.resolve({
    ok: false,
    failedStep,
    error,
    context: ctx,
    steps: [{ id: failedStep, status: 'failed', error }],
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  process.env['FIELD_SALES_REPS_JSON'] = JSON.stringify(REPS);
  mockComm.mockResolvedValue({ ok: true, output: null });
  mockStorage.mockResolvedValue({ ok: true, output: { rows: [] } });
  mockRunFlow.mockImplementation(makeFlowOk);
});

afterEach(() => {
  delete process.env['FIELD_SALES_REPS_JSON'];
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('handleFieldSalesReport — happy path', () => {
  it('completes without error for valid event', async () => {
    await expect(handleFieldSalesReport(VALID_EVENT)).resolves.toBeUndefined();
  });

  it('calls runFlow once', async () => {
    await handleFieldSalesReport(VALID_EVENT);
    expect(mockRunFlow).toHaveBeenCalledTimes(1);
  });

  it('does not send a fallback error message on success', async () => {
    await handleFieldSalesReport(VALID_EVENT);
    // communication.execute may have been called by the flow steps internally,
    // but the handler itself should not send an extra error message.
    // runFlow is mocked so no step actually calls communication — verify no call.
    expect(mockComm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config failure
// ---------------------------------------------------------------------------

describe('handleFieldSalesReport — config failure', () => {
  it('sends error and returns when env var is missing', async () => {
    delete process.env['FIELD_SALES_REPS_JSON'];
    await handleFieldSalesReport(VALID_EVENT);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockComm).toHaveBeenCalledTimes(1);
    const msg = (mockComm.mock.calls[0][0] as { message: string }).message;
    expect(msg.toLowerCase()).toMatch(/misconfigured|support/);
  });

  it('sends error to the event user phone on config failure', async () => {
    delete process.env['FIELD_SALES_REPS_JSON'];
    await handleFieldSalesReport(VALID_EVENT);
    const to = (mockComm.mock.calls[0][0] as { to: string }).to;
    expect(to).toBe(VALID_EVENT.user);
  });

  it('sends error when FIELD_SALES_REPS_JSON is not valid JSON', async () => {
    process.env['FIELD_SALES_REPS_JSON'] = 'not-json';
    await handleFieldSalesReport(VALID_EVENT);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockComm).toHaveBeenCalledTimes(1);
  });

  it('sends error when FIELD_SALES_REPS_JSON is an empty array', async () => {
    process.env['FIELD_SALES_REPS_JSON'] = '[]';
    await handleFieldSalesReport(VALID_EVENT);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockComm).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Context build failure
// ---------------------------------------------------------------------------

describe('handleFieldSalesReport — context build failure', () => {
  it('sends validation error and skips flow when message is invalid', async () => {
    const event: FieldSalesEvent = { ...VALID_EVENT, message: 'garbage text' };
    await handleFieldSalesReport(event);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockComm).toHaveBeenCalledTimes(1);
  });

  it('sends to the rep phone on context failure', async () => {
    const event: FieldSalesEvent = { ...VALID_EVENT, message: 'garbage text' };
    await handleFieldSalesReport(event);
    const to = (mockComm.mock.calls[0][0] as { to: string }).to;
    expect(to).toBe(event.user);
  });

  it('sends error when rep is not in roster', async () => {
    const event: FieldSalesEvent = { ...VALID_EVENT, user: '+910000000000' };
    await handleFieldSalesReport(event);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockComm).toHaveBeenCalledTimes(1);
  });

  it('sends error when region does not match rep', async () => {
    const wrongRegion = VALID_MESSAGE.replace('region: Jaipur', 'region: Mumbai');
    const event: FieldSalesEvent = { ...VALID_EVENT, message: wrongRegion };
    await handleFieldSalesReport(event);
    expect(mockRunFlow).not.toHaveBeenCalled();
    expect(mockComm).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Flow failure
// ---------------------------------------------------------------------------

describe('handleFieldSalesReport — flow failure', () => {
  it('sends fallback error when flow fails', async () => {
    mockRunFlow.mockImplementation(() =>
      makeFlowFail('write-raw-report', 'sheets unreachable'),
    );
    await handleFieldSalesReport(VALID_EVENT);
    expect(mockComm).toHaveBeenCalledTimes(1);
    const msg = (mockComm.mock.calls[0][0] as { message: string }).message;
    expect(msg.toLowerCase()).toMatch(/failed|try again/);
  });

  it('sends fallback to rep phone on flow failure', async () => {
    mockRunFlow.mockImplementation(() =>
      makeFlowFail('check-duplicate', 'timeout'),
    );
    await handleFieldSalesReport(VALID_EVENT);
    const to = (mockComm.mock.calls[0][0] as { to: string }).to;
    expect(to).toBe(VALID_EVENT.user);
  });

  it('does not throw when flow failure communication also fails', async () => {
    mockRunFlow.mockImplementation(() => makeFlowFail('send-confirmation', 'comm error'));
    mockComm.mockRejectedValue(new Error('network error'));
    await expect(handleFieldSalesReport(VALID_EVENT)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Delivery resilience — send() must never throw
// ---------------------------------------------------------------------------

describe('handleFieldSalesReport — delivery resilience', () => {
  it('does not throw when context error communication fails', async () => {
    mockComm.mockRejectedValue(new Error('comm down'));
    const event: FieldSalesEvent = { ...VALID_EVENT, message: 'bad message' };
    await expect(handleFieldSalesReport(event)).resolves.toBeUndefined();
  });

  it('does not throw when config error communication fails', async () => {
    delete process.env['FIELD_SALES_REPS_JSON'];
    mockComm.mockRejectedValue(new Error('comm down'));
    await expect(handleFieldSalesReport(VALID_EVENT)).resolves.toBeUndefined();
  });
});
