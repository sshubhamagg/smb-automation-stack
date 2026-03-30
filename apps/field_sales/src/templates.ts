export const templates = {

  successConfirmation: (
    date: string,
    region: string,
    beat: string,
    total_calls: number,
    orders: number,
    sales_value: number,
  ) =>
    `Report received.
Date: ${date}
Region: ${region} | Beat: ${beat}
Calls: ${total_calls} | Orders: ${orders} | Sales: ${sales_value}
Thank you. Your submission has been recorded.`,

  validationError: (
    reason: string,
  ) =>
    `Submission rejected.
Reason: ${reason}
Please correct the above and resubmit.`,

  duplicateWarning: (
    date: string,
  ) =>
    `Duplicate submission rejected.
A report for ${date} has already been recorded.
Contact your manager if this is a correction.`,

  missingReportReminder: (
    date: string,
    repName: string,
  ) =>
    `Reminder: ${repName}, your report for ${date} has not been received.
Please submit before the cutoff.`,

  managerSummary: (
    date: string,
    managerId: string,
    totalReps: number,
    reportsReceived: number,
    missingReps: string,
    totalSales: number,
    totalOrders: number,
    totalCalls: number,
    topPerformers: string,
    exceptions: string,
  ) =>
    `Daily Performance Summary — ${date}
Manager: ${managerId}

Reps assigned: ${totalReps}
Reports received: ${reportsReceived}
Missing: ${missingReps}

Total sales: ${totalSales}
Total orders: ${totalOrders}
Total calls: ${totalCalls}

Top performers: ${topPerformers}${exceptions ? `\n\nExceptions:\n${exceptions}` : ''}`,

};
