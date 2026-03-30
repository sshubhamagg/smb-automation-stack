import { templates } from '../src/templates';

describe('templates.successConfirmation', () => {
  it('includes all submitted fields', () => {
    const msg = templates.successConfirmation('25 Mar', 'Jaipur', 'Sodala', 18, 7, 24500);
    expect(msg).toContain('25 Mar');
    expect(msg).toContain('Jaipur');
    expect(msg).toContain('Sodala');
    expect(msg).toContain('18');
    expect(msg).toContain('7');
    expect(msg).toContain('24500');
  });

  it('includes confirmation language', () => {
    const msg = templates.successConfirmation('25 Mar', 'Jaipur', 'Sodala', 18, 7, 24500);
    expect(msg.toLowerCase()).toMatch(/received|recorded/);
  });
});

describe('templates.validationError', () => {
  it('includes the rejection reason', () => {
    const msg = templates.validationError('"total_calls" must be >= 0');
    expect(msg).toContain('"total_calls" must be >= 0');
  });

  it('includes instruction to resubmit', () => {
    const msg = templates.validationError('missing field: region');
    expect(msg.toLowerCase()).toContain('resubmit');
  });
});

describe('templates.duplicateWarning', () => {
  it('includes the submitted date', () => {
    const msg = templates.duplicateWarning('25 Mar');
    expect(msg).toContain('25 Mar');
  });

  it('includes the word duplicate', () => {
    const msg = templates.duplicateWarning('25 Mar');
    expect(msg.toLowerCase()).toContain('duplicate');
  });

  it('mentions correction path', () => {
    const msg = templates.duplicateWarning('25 Mar');
    expect(msg.toLowerCase()).toContain('correction');
  });
});

describe('templates.missingReportReminder', () => {
  it('includes rep name and date', () => {
    const msg = templates.missingReportReminder('25 Mar', 'Arjun');
    expect(msg).toContain('25 Mar');
    expect(msg).toContain('Arjun');
  });

  it('includes urgency language', () => {
    const msg = templates.missingReportReminder('25 Mar', 'Priya');
    expect(msg.toLowerCase()).toMatch(/reminder|cutoff|submit/);
  });
});

describe('templates.managerSummary', () => {
  const BASE_ARGS = [
    '25 Mar',
    'mgr-01',
    3,
    2,
    'Karan',
    18000,
    8,
    35,
    'Priya, Arjun',
    '',
  ] as const;

  it('includes all numeric totals', () => {
    const msg = templates.managerSummary(...BASE_ARGS);
    expect(msg).toContain('18000');
    expect(msg).toContain('35');
    expect(msg).toContain('8');
  });

  it('includes missing rep names', () => {
    const msg = templates.managerSummary(...BASE_ARGS);
    expect(msg).toContain('Karan');
  });

  it('includes top performers', () => {
    const msg = templates.managerSummary(...BASE_ARGS);
    expect(msg).toContain('Priya');
    expect(msg).toContain('Arjun');
  });

  it('includes reps assigned and received counts', () => {
    const msg = templates.managerSummary(...BASE_ARGS);
    expect(msg).toContain('3');
    expect(msg).toContain('2');
  });

  it('includes date and manager id', () => {
    const msg = templates.managerSummary(...BASE_ARGS);
    expect(msg).toContain('25 Mar');
    expect(msg).toContain('mgr-01');
  });

  it('omits exceptions section when exceptions string is empty', () => {
    const msg = templates.managerSummary(...BASE_ARGS);
    expect(msg).not.toContain('Exceptions');
  });

  it('includes exceptions section when exceptions string is provided', () => {
    const args = [...BASE_ARGS] as unknown as Parameters<typeof templates.managerSummary>;
    args[9] = '- Karan: zero sales';
    const msg = templates.managerSummary(...args);
    expect(msg).toContain('Exceptions');
    expect(msg).toContain('Karan: zero sales');
  });
});

describe('templates — return type', () => {
  it('all templates return strings', () => {
    expect(typeof templates.successConfirmation('d', 'r', 'b', 0, 0, 0)).toBe('string');
    expect(typeof templates.validationError('e')).toBe('string');
    expect(typeof templates.duplicateWarning('d')).toBe('string');
    expect(typeof templates.missingReportReminder('d', 'n')).toBe('string');
    expect(typeof templates.managerSummary('d', 'm', 0, 0, '', 0, 0, 0, '', '')).toBe('string');
  });
});
