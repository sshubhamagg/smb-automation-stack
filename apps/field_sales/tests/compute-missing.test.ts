import { computeMissing } from '../src/compute-missing';
import type { Rep } from '../src/types';
import type { NormalizedReport } from '../src/types';

function makeRep(rep_id: string, active = true): Rep {
  return { rep_id, name: rep_id, manager_id: 'mgr-01', region: 'Jaipur', phone: '', active };
}

function makeReport(rep_id: string, date: string, status: NormalizedReport['status'] = 'valid'): NormalizedReport {
  return {
    report_id: `${rep_id}_${date}`,
    rep_id,
    date,
    region: 'Jaipur',
    beat: 'Sodala',
    total_calls: 10,
    orders: 2,
    sales_value: 5000,
    stock_issue: false,
    remarks: '',
    status,
    submitted_at: 0,
  };
}

const DATE = '25 Mar';

describe('computeMissing — happy path', () => {
  it('returns empty when all active reps have submitted', () => {
    const reps = [makeRep('r1'), makeRep('r2')];
    const reports = [makeReport('r1', DATE), makeReport('r2', DATE)];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: [] });
  });

  it('returns missing rep when they have not submitted', () => {
    const reps = [makeRep('r1'), makeRep('r2')];
    const reports = [makeReport('r1', DATE)];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: ['r2'] });
  });

  it('returns all reps when no reports exist', () => {
    const reps = [makeRep('r1'), makeRep('r2'), makeRep('r3')];
    expect(computeMissing({ reps, reports: [], date: DATE })).toEqual({
      missing_rep_ids: ['r1', 'r2', 'r3'],
    });
  });
});

describe('computeMissing — inactive reps', () => {
  it('excludes inactive reps from missing list', () => {
    const reps = [makeRep('r1'), makeRep('r2', false)];
    const reports = [makeReport('r1', DATE)];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: [] });
  });

  it('does not count inactive rep as missing even if no report', () => {
    const reps = [makeRep('r1', false), makeRep('r2', false)];
    expect(computeMissing({ reps, reports: [], date: DATE })).toEqual({ missing_rep_ids: [] });
  });
});

describe('computeMissing — date filtering', () => {
  it('ignores reports for a different date', () => {
    const reps = [makeRep('r1')];
    const reports = [makeReport('r1', '24 Mar')];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: ['r1'] });
  });

  it('only counts reports matching the exact target date', () => {
    const reps = [makeRep('r1'), makeRep('r2')];
    const reports = [makeReport('r1', DATE), makeReport('r2', '26 Mar')];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: ['r2'] });
  });
});

describe('computeMissing — invalid report status', () => {
  it('treats "invalid" reports as not submitted', () => {
    const reps = [makeRep('r1')];
    const reports = [makeReport('r1', DATE, 'invalid')];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: ['r1'] });
  });

  it('treats "duplicate" reports as submitted', () => {
    const reps = [makeRep('r1')];
    const reports = [makeReport('r1', DATE, 'duplicate')];
    expect(computeMissing({ reps, reports, date: DATE })).toEqual({ missing_rep_ids: [] });
  });
});

describe('computeMissing — edge cases', () => {
  it('returns empty when reps list is empty', () => {
    const reports = [makeReport('r1', DATE)];
    expect(computeMissing({ reps: [], reports, date: DATE })).toEqual({ missing_rep_ids: [] });
  });

  it('returns empty when both lists are empty', () => {
    expect(computeMissing({ reps: [], reports: [], date: DATE })).toEqual({ missing_rep_ids: [] });
  });

  it('does not mutate the input arrays', () => {
    const reps = [makeRep('r1'), makeRep('r2')];
    const reports = [makeReport('r1', DATE)];
    const repsCopy = [...reps];
    const reportsCopy = [...reports];
    computeMissing({ reps, reports, date: DATE });
    expect(reps).toEqual(repsCopy);
    expect(reports).toEqual(reportsCopy);
  });
});
