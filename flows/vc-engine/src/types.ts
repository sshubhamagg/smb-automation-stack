// ============================================================
// VC Engine — Shared Domain Types
// ============================================================

// ---- Raw sheet rows (after column mapping) ----

export type OrderRow = {
  date: string;
  sku: string;
  channel: string;
  revenue: number;
  orders: number;
};

export type MarketingRow = {
  date: string;
  channel: string;
  spend: number;
};

export type CostRow = {
  sku: string;
  cost: number;
};

// ---- Enriched row (joined: orders + spend + cost) ----

export type EnrichedRow = {
  date: string;
  sku: string;
  channel: string;
  revenue: number;
  orders: number;
  spend: number;
  cost: number;
};

// ---- Row-level computed metrics ----

export type MetricRow = EnrichedRow & {
  roas: number;    // revenue / spend
  cac: number;     // spend / orders
  aov: number;     // revenue / orders
  margin: number;  // revenue - spend - cost
};

// ---- Aggregated metrics (by channel + sku + date) ----

export type Aggregate = {
  channel: string;
  sku: string;
  date: string;
  totalRevenue: number;
  avgRoas: number;
  avgCac: number;
  avgMargin: number;
  rowCount: number;
};

// ---- Rule engine alerts ----

export type AlertType = 'LOW_ROAS' | 'HIGH_CAC' | 'NEGATIVE_MARGIN';

export type Alert = {
  type: AlertType;
  channel: string;
  sku: string;
  date: string;
  value: number;
  threshold: number;
};

// ---- CEO Snapshot ----

export type Snapshot = {
  date: string;
  totalRevenue: number;
  avgRoas: number;
  avgCac: number;
  topChannel: string;
  worstChannel: string;
  alertCount: number;
  alertSummary: string;
};

// ---- Config ----

export type Thresholds = {
  minRoas: number;   // ROAS below this → LOW_ROAS alert
  maxCac: number;    // CAC above this  → HIGH_CAC alert
};

export type ColumnMap = {
  orders: {
    date: string;
    sku: string;
    channel: string;
    revenue: string;
    orders: string;
  };
  marketing: {
    date: string;
    channel: string;
    spend: string;
  };
  costs: {
    sku: string;
    cost: string;
  };
};

export type VCEngineConfig = {
  ordersSheetId: string;
  marketingSheetId: string;
  costsSheetId: string;
  outputSheetId: string;
  thresholds: Thresholds;
  columnMap: ColumnMap;
};

// ---- ctx.state shape for vc-engine flows ----

export type VCEngineState = {
  config: VCEngineConfig;
  data: {
    enriched: EnrichedRow[];
    metrics: MetricRow[];
    aggregates: Aggregate[];
    alerts: Alert[];
    snapshot: Snapshot | null;
  };
};
