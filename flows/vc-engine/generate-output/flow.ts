// ============================================================
// Flow 5: generate-output
//
// Responsibilities:
//   - Build CEO Snapshot from aggregates + alerts
//   - Write 4 output rows to Google Sheets:
//       METRICS_RAW   — overall metrics summary row
//       AGGREGATES    — top-channel performance row
//       ALERTS        — per alert-type rows (conditional)
//       CEO_SNAPSHOT  — executive summary row
//
// buildInitialContext() computes the snapshot.
// Engine steps write each output to the configured sheet.
//
// Steps:
//   1. write-snapshot         — always — CEO_SNAPSHOT tab
//   2. write-metrics-summary  — always — METRICS_RAW tab
//   3. write-aggregates-top   — always — AGGREGATES tab
//   4. write-alert-low-roas   — conditional — ALERTS tab
//   5. write-alert-high-cac   — conditional — ALERTS tab
//   6. write-alert-neg-margin — conditional — ALERTS tab
// ============================================================

import type { Flow, ExecutionContext } from '../../../modules/engine/src/types';
import type {
  VCEngineConfig,
  EnrichedRow,
  MetricRow,
  Aggregate,
  Alert,
  Snapshot,
  VCEngineState,
} from '../src/types';
import { safeDivide, round2, fmtCurrency, todayIso } from '../src/utils';

// ---------------------------------------------------------------------------
// CEO Snapshot generation (pure)
// ---------------------------------------------------------------------------

function buildSnapshot(aggregates: Aggregate[], alerts: Alert[]): Snapshot {
  if (aggregates.length === 0) {
    return {
      date: todayIso(),
      totalRevenue: 0,
      avgRoas: 0,
      avgCac: 0,
      topChannel: 'N/A',
      worstChannel: 'N/A',
      alertCount: alerts.length,
      alertSummary: alerts.length === 0 ? 'No alerts' : alerts.map(a => a.type).join(', '),
    };
  }

  const totalRevenue = round2(aggregates.reduce((s, a) => s + a.totalRevenue, 0));
  const avgRoas      = round2(safeDivide(aggregates.reduce((s, a) => s + a.avgRoas, 0), aggregates.length));
  const avgCac       = round2(safeDivide(aggregates.reduce((s, a) => s + a.avgCac,  0), aggregates.length));

  // Top channel = highest totalRevenue; worst = lowest
  const sorted     = [...aggregates].sort((a, b) => b.totalRevenue - a.totalRevenue);
  const topChannel  = sorted[0]?.channel ?? 'N/A';
  const worstChannel = sorted[sorted.length - 1]?.channel ?? 'N/A';

  const alertSummary = alerts.length === 0
    ? 'No alerts'
    : alerts.map(a => `${a.type}(${a.channel})`).join('; ');

  return {
    date: todayIso(),
    totalRevenue,
    avgRoas,
    avgCac,
    topChannel,
    worstChannel,
    alertCount: alerts.length,
    alertSummary,
  };
}

// ---------------------------------------------------------------------------
// buildInitialContext
// ---------------------------------------------------------------------------

export function buildInitialContext(
  enriched: EnrichedRow[],
  metrics: MetricRow[],
  aggregates: Aggregate[],
  alerts: Alert[],
  config: VCEngineConfig,
): ExecutionContext {
  const snapshot = buildSnapshot(aggregates, alerts);

  return {
    state: {
      config,
      data: {
        enriched,
        metrics,
        aggregates,
        alerts,
        snapshot,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — safe state accessors (pure, non-throwing)
// ---------------------------------------------------------------------------

function getState(ctx: ExecutionContext): VCEngineState {
  return ctx.state as VCEngineState;
}

function alertsOfType(ctx: ExecutionContext, type: string): Alert[] {
  return (getState(ctx).data.alerts ?? []).filter(a => a.type === type);
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const generateOutputFlow: Flow = {
  id: 'generate-output',
  steps: [

    // ── Step 1: Write CEO Snapshot ─────────────────────────────────────────
    {
      id: 'write-snapshot',
      type: 'storage',
      input: (ctx: ExecutionContext) => {
        const s = getState(ctx).data.snapshot!;
        return {
          provider: 'sheets',
          operation: 'write',
          resource: getState(ctx).config.outputSheetId,
          data: [
            s.date,
            fmtCurrency(s.totalRevenue),
            String(s.avgRoas),
            String(s.avgCac),
            s.topChannel,
            s.worstChannel,
            String(s.alertCount),
            s.alertSummary,
          ],
          options: { range: 'CEO_SNAPSHOT' },
        };
      },
    },

    // ── Step 2: Write Metrics Summary ─────────────────────────────────────
    {
      id: 'write-metrics-summary',
      type: 'storage',
      input: (ctx: ExecutionContext) => {
        const { metrics, snapshot } = getState(ctx).data;
        const rowCount  = metrics.length;
        const avgRoas   = round2(safeDivide(metrics.reduce((s, r) => s + r.roas,   0), rowCount));
        const avgCac    = round2(safeDivide(metrics.reduce((s, r) => s + r.cac,    0), rowCount));
        const avgMargin = round2(safeDivide(metrics.reduce((s, r) => s + r.margin, 0), rowCount));
        return {
          provider: 'sheets',
          operation: 'write',
          resource: getState(ctx).config.outputSheetId,
          data: [
            snapshot?.date ?? todayIso(),
            String(rowCount),
            String(avgRoas),
            String(avgCac),
            String(avgMargin),
          ],
          options: { range: 'METRICS_RAW' },
        };
      },
    },

    // ── Step 3: Write Top Channel Aggregates ──────────────────────────────
    {
      id: 'write-aggregates-top',
      type: 'storage',
      input: (ctx: ExecutionContext) => {
        const { aggregates } = getState(ctx).data;
        // Sort by revenue desc; write top-performing channel row
        const top = [...aggregates].sort((a, b) => b.totalRevenue - a.totalRevenue)[0];
        const row = top
          ? [top.date, top.channel, top.sku, fmtCurrency(top.totalRevenue), String(top.avgRoas), String(top.avgCac), String(top.avgMargin), String(top.rowCount)]
          : [todayIso(), 'N/A', 'N/A', '0.00', '0', '0', '0', '0'];
        return {
          provider: 'sheets',
          operation: 'write',
          resource: getState(ctx).config.outputSheetId,
          data: row,
          options: { range: 'AGGREGATES' },
        };
      },
    },

    // ── Step 4: Write LOW_ROAS alert row (conditional) ────────────────────
    {
      id: 'write-alert-low-roas',
      type: 'storage',
      condition: (ctx: ExecutionContext) => alertsOfType(ctx, 'LOW_ROAS').length > 0,
      input: (ctx: ExecutionContext) => {
        const a = alertsOfType(ctx, 'LOW_ROAS')[0]!;
        return {
          provider: 'sheets',
          operation: 'write',
          resource: getState(ctx).config.outputSheetId,
          data: [
            a.date,
            a.type,
            a.channel,
            a.sku,
            String(round2(a.value)),
            String(a.threshold),
            `ROAS ${a.value} below minimum ${a.threshold}`,
          ],
          options: { range: 'ALERTS' },
        };
      },
    },

    // ── Step 5: Write HIGH_CAC alert row (conditional) ────────────────────
    {
      id: 'write-alert-high-cac',
      type: 'storage',
      condition: (ctx: ExecutionContext) => alertsOfType(ctx, 'HIGH_CAC').length > 0,
      input: (ctx: ExecutionContext) => {
        const a = alertsOfType(ctx, 'HIGH_CAC')[0]!;
        return {
          provider: 'sheets',
          operation: 'write',
          resource: getState(ctx).config.outputSheetId,
          data: [
            a.date,
            a.type,
            a.channel,
            a.sku,
            String(round2(a.value)),
            String(a.threshold),
            `CAC ${a.value} above maximum ${a.threshold}`,
          ],
          options: { range: 'ALERTS' },
        };
      },
    },

    // ── Step 6: Write NEGATIVE_MARGIN alert row (conditional) ─────────────
    {
      id: 'write-alert-neg-margin',
      type: 'storage',
      condition: (ctx: ExecutionContext) => alertsOfType(ctx, 'NEGATIVE_MARGIN').length > 0,
      input: (ctx: ExecutionContext) => {
        const a = alertsOfType(ctx, 'NEGATIVE_MARGIN')[0]!;
        return {
          provider: 'sheets',
          operation: 'write',
          resource: getState(ctx).config.outputSheetId,
          data: [
            a.date,
            a.type,
            a.channel,
            a.sku,
            String(round2(a.value)),
            String(a.threshold),
            `Margin ${a.value} — loss-making SKU/channel`,
          ],
          options: { range: 'ALERTS' },
        };
      },
    },

  ],
};
