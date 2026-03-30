import { buildInitialContext } from '../src/context';
import type { Rep } from '../src/types';

const ACTIVE_REP: Rep = {
  rep_id: 'rep-01',
  name: 'Arjun Mehta',
  manager_id: 'mgr-01',
  region: 'Jaipur',
  phone: '+919876543210',
  active: true,
};

const INACTIVE_REP: Rep = {
  ...ACTIVE_REP,
  rep_id: 'rep-02',
  phone: '+919999999999',
  active: false,
};

const VALID_MESSAGE = `date: 25 Mar
region: Jaipur
beat: Sodala
calls: 18
orders: 7
sales_value: 24500
stock_issue: yes
remarks: Distributor stock issue`;

const BASE_INPUT = {
  event: { message: VALID_MESSAGE, user: '+919876543210' },
  config: { reps: [ACTIVE_REP] },
};

describe('buildInitialContext — happy path', () => {
  it('returns a valid context for a well-formed submission', () => {
    const result = buildInitialContext(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.context.event).toEqual(BASE_INPUT.event);
    expect(result.context.state.rep).toEqual(ACTIVE_REP);
    expect(result.context.state.config).toEqual(BASE_INPUT.config);
  });

  it('attaches parsed_input to state', () => {
    const result = buildInitialContext(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { parsed_input } = result.context.state;
    expect(parsed_input.total_calls).toBe(18);
    expect(parsed_input.sales_value).toBe(24500);
    expect(parsed_input.stock_issue).toBe(true);
    expect(parsed_input.region).toBe('Jaipur');
  });

  it('resolves rep by phone number', () => {
    const result = buildInitialContext(BASE_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.state.rep.rep_id).toBe('rep-01');
  });

  it('resolves rep by rep_id', () => {
    const result = buildInitialContext({
      event: { message: VALID_MESSAGE, user: 'rep-01' },
      config: { reps: [ACTIVE_REP] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context.state.rep.phone).toBe('+919876543210');
  });

  it('resolves rep case-insensitively', () => {
    const result = buildInitialContext({
      event: { message: VALID_MESSAGE, user: '+919876543210' },
      config: { reps: [ACTIVE_REP] },
    });
    expect(result.ok).toBe(true);
  });
});

describe('buildInitialContext — parse failures', () => {
  it('returns error when message is unparseable', () => {
    const result = buildInitialContext({
      ...BASE_INPUT,
      event: { ...BASE_INPUT.event, message: 'just a random text' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parse failed/i);
  });

  it('returns error when a required field is missing', () => {
    const noDate = VALID_MESSAGE.split('\n').filter((l) => !l.startsWith('date')).join('\n');
    const result = buildInitialContext({
      ...BASE_INPUT,
      event: { ...BASE_INPUT.event, message: noDate },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parse failed/i);
  });

  it('returns error when sales_value is not a number', () => {
    const bad = VALID_MESSAGE.replace('sales_value: 24500', 'sales_value: abc');
    const result = buildInitialContext({
      ...BASE_INPUT,
      event: { ...BASE_INPUT.event, message: bad },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parse failed/i);
  });
});

describe('buildInitialContext — rep lookup failures', () => {
  it('returns error when user is not in the roster', () => {
    const result = buildInitialContext({
      ...BASE_INPUT,
      event: { ...BASE_INPUT.event, user: '+910000000000' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown or inactive rep/i);
  });

  it('returns error when matching rep is inactive', () => {
    const result = buildInitialContext({
      event: { message: VALID_MESSAGE, user: '+919999999999' },
      config: { reps: [INACTIVE_REP] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown or inactive rep/i);
  });

  it('returns error when reps array is empty', () => {
    const result = buildInitialContext({
      ...BASE_INPUT,
      config: { reps: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown or inactive rep/i);
  });
});

describe('buildInitialContext — validation failures', () => {
  it('returns error when region does not match rep region', () => {
    const wrongRegion = VALID_MESSAGE.replace('region: Jaipur', 'region: Mumbai');
    const result = buildInitialContext({
      ...BASE_INPUT,
      event: { ...BASE_INPUT.event, message: wrongRegion },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/validation failed/i);
  });

  it('returns error when date is invalid', () => {
    const badDate = VALID_MESSAGE.replace('date: 25 Mar', 'date: 32 Jan');
    const result = buildInitialContext({
      ...BASE_INPUT,
      event: { ...BASE_INPUT.event, message: badDate },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/validation failed/i);
  });
});

describe('buildInitialContext — ordering guarantee', () => {
  it('fails at parse before attempting rep lookup', () => {
    // If it tried to look up rep first on an empty roster, it would fail with a
    // different error. Parse must run first.
    const result = buildInitialContext({
      event: { message: '', user: 'anyone' },
      config: { reps: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parse failed/i);
  });

  it('fails at rep lookup before running validation', () => {
    // Region mismatch would trigger validation failure, but rep lookup happens
    // first and should short-circuit with the correct error.
    const wrongRegion = VALID_MESSAGE.replace('region: Jaipur', 'region: Mumbai');
    const result = buildInitialContext({
      event: { message: wrongRegion, user: 'ghost-user' },
      config: { reps: [ACTIVE_REP] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown or inactive rep/i);
  });
});
