// ============================================================
// VC Engine — Handler
//
// Orchestrates 5 flows sequentially:
//   1. read-and-normalize  — storage reads (3 steps)
//   2. compute-metrics     — pure computation, no engine steps
//   3. aggregate-metrics   — pure computation, no engine steps
//   4. evaluate-rules      — pure computation, no engine steps
//   5. generate-output     — storage writes (6 steps)
//
// Data is passed forward via ctx.state.data between flows.
// No business logic lives here — only orchestration.
// ============================================================

import { execute as storageExecute } from 'storage-module';
import { runFlow } from 'engine-module';
import type { Modules } from 'engine-module';

import {
  buildInitialContext as buildReadCtx,
  readAndNormalizeFlow,
  normalizeAndJoin,
} from '../../../flows/vc-engine/read-and-normalize/flow';

import {
  buildInitialContext as buildMetricsCtx,
  computeMetricsFlow,
} from '../../../flows/vc-engine/compute-metrics/flow';

import {
  buildInitialContext as buildAggregateCtx,
  aggregateMetricsFlow,
} from '../../../flows/vc-engine/aggregate-metrics/flow';

import {
  buildInitialContext as buildRulesCtx,
  evaluateRulesFlow,
} from '../../../flows/vc-engine/evaluate-rules/flow';

import {
  buildInitialContext as buildOutputCtx,
  generateOutputFlow,
} from '../../../flows/vc-engine/generate-output/flow';

import type { VCEngineConfig, VCEngineState } from '../../../flows/vc-engine/src/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function loadConfig(): VCEngineConfig {
  const ordersSheetId    = process.env['VC_ORDERS_SHEET_ID'];
  const marketingSheetId = process.env['VC_MARKETING_SHEET_ID'];
  const costsSheetId     = process.env['VC_COSTS_SHEET_ID'];
  const outputSheetId    = process.env['VC_OUTPUT_SHEET_ID'];

  if (!ordersSheetId || !marketingSheetId || !costsSheetId || !outputSheetId) {
    throw new Error(
      'Missing required env vars: VC_ORDERS_SHEET_ID, VC_MARKETING_SHEET_ID, VC_COSTS_SHEET_ID, VC_OUTPUT_SHEET_ID',
    );
  }

  return {
    ordersSheetId,
    marketingSheetId,
    costsSheetId,
    outputSheetId,
    thresholds: {
      minRoas: parseFloat(process.env['VC_MIN_ROAS'] ?? '2.0'),
      maxCac:  parseFloat(process.env['VC_MAX_CAC']  ?? '500'),
    },
    columnMap: {
      orders: {
        date:    process.env['VC_COL_ORDERS_DATE']    ?? 'Date',
        sku:     process.env['VC_COL_ORDERS_SKU']     ?? 'SKU',
        channel: process.env['VC_COL_ORDERS_CHANNEL'] ?? 'Channel',
        revenue: process.env['VC_COL_ORDERS_REVENUE'] ?? 'Revenue',
        orders:  process.env['VC_COL_ORDERS_ORDERS']  ?? 'Orders',
      },
      marketing: {
        date:    process.env['VC_COL_MKT_DATE']    ?? 'Date',
        channel: process.env['VC_COL_MKT_CHANNEL'] ?? 'Channel',
        spend:   process.env['VC_COL_MKT_SPEND']   ?? 'Spend',
      },
      costs: {
        sku:  process.env['VC_COL_COSTS_SKU']  ?? 'SKU',
        cost: process.env['VC_COL_COSTS_COST'] ?? 'Cost',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Modules (storage only — vc-engine does not use communication or intelligence)
// ---------------------------------------------------------------------------

const modules: Modules = {
  storage: (input: unknown) => storageExecute(input as Parameters<typeof storageExecute>[0]),
};

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleVcEngine(): Promise<void> {
  // ── Load config ────────────────────────────────────────────────────────
  let config: VCEngineConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error('[vc-engine] Config error:', err instanceof Error ? err.message : err);
    return;
  }

  console.log('[vc-engine] Starting pipeline');

  // ── Flow 1: Read + Normalize ───────────────────────────────────────────
  const readCtx    = buildReadCtx(config);
  const readResult = await runFlow(readAndNormalizeFlow, readCtx, modules);

  if (!readResult.ok) {
    console.error('[vc-engine] read-and-normalize failed:', readResult.error, '| step:', readResult.failedStep);
    return;
  }

  // Extract raw rows from step outputs
  const ordersOutput    = readResult.context.outputs?.['read-orders']    as { rows: Record<string, string>[] } | undefined;
  const marketingOutput = readResult.context.outputs?.['read-marketing'] as { rows: Record<string, string>[] } | undefined;
  const costsOutput     = readResult.context.outputs?.['read-costs']     as { rows: Record<string, string>[] } | undefined;

  const ordersRows    = ordersOutput?.rows    ?? [];
  const marketingRows = marketingOutput?.rows ?? [];
  const costsRows     = costsOutput?.rows     ?? [];

  console.log(`[vc-engine] Read: ${ordersRows.length} orders, ${marketingRows.length} marketing, ${costsRows.length} costs`);

  // Normalize + join into enriched rows
  const enriched = normalizeAndJoin(ordersRows, marketingRows, costsRows, config);
  console.log(`[vc-engine] Enriched rows: ${enriched.length}`);

  // ── Flow 2: Compute Metrics ────────────────────────────────────────────
  const metricsCtx    = buildMetricsCtx(enriched, config);
  const metricsResult = await runFlow(computeMetricsFlow, metricsCtx, modules);

  if (!metricsResult.ok) {
    console.error('[vc-engine] compute-metrics failed:', metricsResult.error);
    return;
  }

  const metricsState = metricsResult.context.state as VCEngineState;
  const { metrics }  = metricsState.data;
  console.log(`[vc-engine] Metrics computed: ${metrics.length} rows`);

  // ── Flow 3: Aggregate Metrics ──────────────────────────────────────────
  const aggregateCtx    = buildAggregateCtx(enriched, metrics, config);
  const aggregateResult = await runFlow(aggregateMetricsFlow, aggregateCtx, modules);

  if (!aggregateResult.ok) {
    console.error('[vc-engine] aggregate-metrics failed:', aggregateResult.error);
    return;
  }

  const aggregateState = aggregateResult.context.state as VCEngineState;
  const { aggregates } = aggregateState.data;
  console.log(`[vc-engine] Aggregates: ${aggregates.length} groups`);

  // ── Flow 4: Evaluate Rules ─────────────────────────────────────────────
  const rulesCtx    = buildRulesCtx(enriched, metrics, aggregates, config);
  const rulesResult = await runFlow(evaluateRulesFlow, rulesCtx, modules);

  if (!rulesResult.ok) {
    console.error('[vc-engine] evaluate-rules failed:', rulesResult.error);
    return;
  }

  const rulesState = rulesResult.context.state as VCEngineState;
  const { alerts } = rulesState.data;
  console.log(`[vc-engine] Alerts triggered: ${alerts.length}`);
  if (alerts.length > 0) {
    for (const alert of alerts) {
      console.log(`  → ${alert.type} | channel: ${alert.channel} | sku: ${alert.sku} | value: ${alert.value}`);
    }
  }

  // ── Flow 5: Generate Output ────────────────────────────────────────────
  const outputCtx    = buildOutputCtx(enriched, metrics, aggregates, alerts, config);
  const outputResult = await runFlow(generateOutputFlow, outputCtx, modules);

  if (!outputResult.ok) {
    console.error('[vc-engine] generate-output failed:', outputResult.error, '| step:', outputResult.failedStep);
    return;
  }

  const outputState = outputResult.context.state as VCEngineState;
  const { snapshot } = outputState.data;

  console.log('[vc-engine] Pipeline complete');
  console.log(`[vc-engine] Snapshot — Revenue: ${snapshot?.totalRevenue} | ROAS: ${snapshot?.avgRoas} | CAC: ${snapshot?.avgCac} | Top: ${snapshot?.topChannel} | Alerts: ${snapshot?.alertCount}`);
}
