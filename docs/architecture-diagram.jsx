import { useState } from "react";

const COLORS = {
  app: { bg: "#1e3a5f", border: "#3b82f6", text: "#93c5fd", accent: "#3b82f6" },
  engine: { bg: "#1a1a2e", border: "#8b5cf6", text: "#c4b5fd", accent: "#8b5cf6" },
  ingestion: { bg: "#1a2e1a", border: "#22c55e", text: "#86efac", accent: "#22c55e" },
  storage: { bg: "#2e1a1a", border: "#ef4444", text: "#fca5a5", accent: "#ef4444" },
  intelligence: { bg: "#2e2a1a", border: "#f59e0b", text: "#fcd34d", accent: "#f59e0b" },
  communication: { bg: "#1a2a2e", border: "#06b6d4", text: "#67e8f9", accent: "#06b6d4" },
  flow: { bg: "#1e1e2e", border: "#a78bfa", text: "#ddd6fe", accent: "#a78bfa" },
  shared: { bg: "#1e1e1e", border: "#6b7280", text: "#d1d5db", accent: "#6b7280" },
};

const E2E_STEPS = [
  {
    id: 1,
    layer: "external",
    title: "User sends WhatsApp message",
    detail: 'User types: "paid Raj 500"',
    code: `// Incoming Meta webhook payload
POST /webhook
{
  "object": "whatsapp_business_account",
  "entry": [{
    "changes": [{
      "value": {
        "messages": [{
          "from": "919876543210",
          "text": { "body": "paid Raj 500" },
          "timestamp": "1711123456"
        }]
      }
    }]
  }]
}`,
    highlight: null,
  },
  {
    id: 2,
    layer: "app",
    title: "apps/ledger — server.ts receives webhook",
    detail: "Express route validates and passes to handler",
    code: `// apps/ledger/src/server.ts
app.post('/webhook', async (req, res) => {
  const result = await handleIncoming(req.body);
  res.json(result);
});`,
    highlight: "app",
  },
  {
    id: 3,
    layer: "ingestion",
    title: "ingestion-module normalizes the event",
    detail: "Meta adapter verifies signature, extracts canonical NormalizedEvent",
    code: `// modules/ingestion/src/adapters/meta.ts
const result = await receive({
  source: 'whatsapp',
  provider: 'meta',
  payload: req.body,
  secret: process.env.WEBHOOK_VERIFY_TOKEN
});

// NormalizedEvent output:
{
  userId: "919876543210",   // E.164 phone
  message: "paid Raj 500",
  timestamp: 1711123456,
  metadata: { messageId: "wamid.xxx", type: "text" }
}`,
    highlight: "ingestion",
  },
  {
    id: 4,
    layer: "engine",
    title: "engine runs intent-router flow",
    detail: "Flow steps execute sequentially — structured parse first, AI if ambiguous",
    code: `// flows/ledger/intent-router/flow.ts
const flow = {
  steps: [
    { id: "parse",    type: "ai",      action: "extraction",    condition: ctx => mode === 'ai' },
    { id: "classify", type: "ai",      action: "classification", condition: ctx => !ctx.outputs.parse },
    { id: "route",    type: "storage", action: "read",          ... },
  ]
};

// engine/src/runner.ts
for (const step of flow.steps) {
  if (step.condition && !step.condition(ctx)) continue; // skip
  const result = await executeStep(step, ctx, modules);
  if (!result.ok) return { ok: false, stepId: step.id, error: result.error };
  ctx.outputs[step.id] = result.output;
}`,
    highlight: "engine",
  },
  {
    id: 5,
    layer: "intelligence",
    title: "intelligence-module extracts intent",
    detail: "Runs extraction task → structured fields from free text",
    code: `// modules/intelligence/src/pipeline.ts
const aiResult = await run({
  task: "extraction",
  provider: "openai",
  input: "paid Raj 500",
  schema: {
    intent: "string",   // "ledger_entry"
    party:  "string",   // "Raj"
    amount: "number",   // 500
    type:   "string"    // "debit"
  }
});

// Output stored at ctx.outputs["extract"]
{
  intent: "ledger_entry",
  party:  "Raj",
  amount: 500,
  type:   "debit"
}`,
    highlight: "intelligence",
  },
  {
    id: 6,
    layer: "engine",
    title: "engine runs ledger-entry flow",
    detail: "Intent = ledger_entry → engine runs the entry sub-flow",
    code: `// flows/ledger/ledger-entry/flow.ts
steps: [
  { id: "check-duplicate", type: "storage", action: "query",  ... },
  { id: "write-entry",     type: "storage", action: "write",
    condition: ctx => !ctx.outputs["check-duplicate"].isDuplicate },
  { id: "confirm",         type: "communication", action: "send",
    condition: ctx => ctx.outputs["write-entry"]?.ok },
  { id: "warn-duplicate",  type: "communication", action: "send",
    condition: ctx => ctx.outputs["check-duplicate"].isDuplicate },
]`,
    highlight: "engine",
  },
  {
    id: 7,
    layer: "storage",
    title: "storage-module checks for duplicates",
    detail: "Queries Google Sheets for matching entry in last 5 minutes",
    code: `// modules/storage/src/adapters/sheets.ts
const queryResult = await execute({
  provider: "sheets",
  operation: "query",
  resource: { sheetId: process.env.LEDGER_SHEET_ID, range: "A:E" },
  query: {
    filters: [
      { column: "party",  value: "Raj"   },
      { column: "amount", value: 500     },
      { column: "ts",     op: ">",  value: Date.now() - 5*60*1000 }
    ]
  }
});
// { ok: true, output: { rows: [], isDuplicate: false } }`,
    highlight: "storage",
  },
  {
    id: 8,
    layer: "storage",
    title: "storage-module writes the entry",
    detail: "Appends new row to Google Sheets ledger",
    code: `// modules/storage/src/adapters/sheets.ts
const writeResult = await execute({
  provider: "sheets",
  operation: "write",
  resource: { sheetId: process.env.LEDGER_SHEET_ID, range: "A:E" },
  data: {
    ts:     new Date().toISOString(),
    userId: "919876543210",
    party:  "Raj",
    amount: 500,
    type:   "debit"
  }
});
// { ok: true, output: { rowIndex: 42 } }`,
    highlight: "storage",
  },
  {
    id: 9,
    layer: "communication",
    title: "communication-module sends confirmation",
    detail: "WhatsApp reply via Meta Graph API",
    code: `// modules/communication/src/meta.ts
const sendResult = await execute({
  provider: "meta",
  to:      "919876543210",
  message: "✅ Entry recorded: Paid Raj ₹500 (debit)"
});

// Meta Graph API call:
POST https://graph.facebook.com/v18.0/{phoneNumberId}/messages
{
  "messaging_product": "whatsapp",
  "to": "919876543210",
  "type": "text",
  "text": { "body": "✅ Entry recorded: Paid Raj ₹500 (debit)" }
}`,
    highlight: "communication",
  },
  {
    id: 10,
    layer: "external",
    title: "User receives WhatsApp reply",
    detail: '"✅ Entry recorded: Paid Raj ₹500 (debit)"',
    code: `// Full ExecutionContext at end of flow:
{
  event: { userId: "919876543210", message: "paid Raj 500", ... },
  outputs: {
    "extract":         { intent: "ledger_entry", party: "Raj", amount: 500 },
    "check-duplicate": { rows: [], isDuplicate: false },
    "write-entry":     { rowIndex: 42 },
    "confirm":         null  // communication returns null output
  }
}

// ExecutionResult:
{ ok: true, context: { ... } }`,
    highlight: null,
  },
];

const ARCH_LAYERS = [
  {
    key: "app",
    label: "APPS",
    sublabel: "apps/ledger · apps/mining",
    desc: "Express servers, webhook receivers, flow dispatch",
    color: COLORS.app,
    items: ["ledger/server.ts", "mining/server.ts", "handler.ts", "cron jobs"],
  },
  {
    key: "engine",
    label: "ENGINE",
    sublabel: "modules/engine",
    desc: "Sequential step executor, condition eval, fail-fast, no business logic",
    color: COLORS.engine,
    items: ["runner.ts", "stepExecutor.ts", "types.ts"],
  },
];

const MODULE_BOXES = [
  {
    key: "ingestion",
    label: "ingestion",
    color: COLORS.ingestion,
    adapters: ["meta/whatsapp"],
    ops: ["receive()"],
    desc: "Normalize webhooks → NormalizedEvent",
  },
  {
    key: "storage",
    label: "storage",
    color: COLORS.storage,
    adapters: ["sheets", "postgres"],
    ops: ["read", "write", "update", "query"],
    desc: "Abstract persistence layer",
  },
  {
    key: "intelligence",
    label: "intelligence",
    color: COLORS.intelligence,
    adapters: ["openai", "anthropic", "ollama", "nvidia"],
    ops: ["classification", "extraction", "qa", "reasoning"],
    desc: "LLM orchestration with task registry",
  },
  {
    key: "communication",
    label: "communication",
    color: COLORS.communication,
    adapters: ["meta", "twilio", "telegram"],
    ops: ["execute()"],
    desc: "Outbound message dispatch",
  },
];

function Badge({ label, color }) {
  return (
    <span
      style={{
        background: color + "22",
        border: `1px solid ${color}55`,
        color: color,
        borderRadius: 4,
        padding: "1px 7px",
        fontSize: 11,
        fontFamily: "monospace",
        marginRight: 4,
        marginBottom: 4,
        display: "inline-block",
      }}
    >
      {label}
    </span>
  );
}

function ArchDiagram({ highlightModule }) {
  return (
    <div style={{ fontFamily: "monospace" }}>
      {/* External */}
      <div
        style={{
          border: "1.5px dashed #4b5563",
          borderRadius: 10,
          padding: "10px 16px",
          marginBottom: 10,
          color: "#9ca3af",
          fontSize: 13,
          textAlign: "center",
        }}
      >
        <span style={{ fontSize: 18 }}>📱</span> WhatsApp User (external)
      </div>

      {/* Arrow down */}
      <div style={{ textAlign: "center", color: "#4b5563", fontSize: 20, lineHeight: 1.2, marginBottom: 4 }}>↕ Meta Webhook</div>

      {/* Apps */}
      {ARCH_LAYERS.map((layer) => (
        <div
          key={layer.key}
          style={{
            border: `1.5px solid ${layer.color.border}`,
            borderRadius: 10,
            background: layer.color.bg,
            padding: "10px 16px",
            marginBottom: 10,
          }}
        >
          <div style={{ color: layer.color.text, fontWeight: "bold", fontSize: 13, marginBottom: 2 }}>
            {layer.label}{" "}
            <span style={{ fontWeight: "normal", opacity: 0.7, fontSize: 11 }}>
              {layer.sublabel}
            </span>
          </div>
          <div style={{ color: layer.color.text, opacity: 0.7, fontSize: 11, marginBottom: 6 }}>
            {layer.desc}
          </div>
          <div>
            {layer.items.map((i) => (
              <Badge key={i} label={i} color={layer.color.accent} />
            ))}
          </div>
        </div>
      ))}

      {/* Arrow */}
      <div style={{ textAlign: "center", color: "#4b5563", fontSize: 13, marginBottom: 6 }}>
        ↓ modules[step.type](input)
      </div>

      {/* 4 modules in grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
          marginBottom: 10,
        }}
      >
        {MODULE_BOXES.map((mod) => {
          const isHighlighted = highlightModule === mod.key;
          return (
            <div
              key={mod.key}
              style={{
                border: `${isHighlighted ? 2.5 : 1.5}px solid ${mod.color.border}`,
                borderRadius: 9,
                background: mod.color.bg,
                padding: "8px 12px",
                transition: "all 0.3s",
                boxShadow: isHighlighted ? `0 0 16px ${mod.color.accent}55` : "none",
                transform: isHighlighted ? "scale(1.03)" : "scale(1)",
              }}
            >
              <div style={{ color: mod.color.text, fontWeight: "bold", fontSize: 12, marginBottom: 2 }}>
                {mod.label}
              </div>
              <div style={{ color: mod.color.text, opacity: 0.65, fontSize: 10, marginBottom: 5 }}>
                {mod.desc}
              </div>
              <div style={{ marginBottom: 3 }}>
                {mod.adapters.map((a) => (
                  <Badge key={a} label={a} color={mod.color.accent} />
                ))}
              </div>
              <div style={{ borderTop: `1px solid ${mod.color.border}33`, paddingTop: 4, marginTop: 2 }}>
                {mod.ops.map((o) => (
                  <Badge key={o} label={o} color={mod.color.accent} />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Shared types */}
      <div
        style={{
          border: `1px dashed ${COLORS.shared.border}`,
          borderRadius: 8,
          background: COLORS.shared.bg,
          padding: "7px 14px",
          textAlign: "center",
        }}
      >
        <span style={{ color: COLORS.shared.text, fontSize: 11 }}>
          <strong>shared-types</strong> — ModuleResult&lt;T&gt; · canonical contract
        </span>
      </div>

      {/* Flows */}
      <div
        style={{
          border: `1px solid ${COLORS.flow.border}`,
          borderRadius: 8,
          background: COLORS.flow.bg,
          padding: "8px 14px",
          marginTop: 10,
        }}
      >
        <div style={{ color: COLORS.flow.text, fontWeight: "bold", fontSize: 12, marginBottom: 4 }}>
          FLOWS (business logic lives here)
        </div>
        <div>
          {[
            "intent-router",
            "ledger-entry",
            "ledger-balance",
            "ledger-summary",
            "mining-reporting",
            "daily-summary",
            "missed-reports",
          ].map((f) => (
            <Badge key={f} label={f} color={COLORS.flow.accent} />
          ))}
        </div>
      </div>
    </div>
  );
}

const LAYER_COLORS = {
  external: { bg: "#1c1c1c", border: "#4b5563", text: "#9ca3af" },
  app: COLORS.app,
  ingestion: COLORS.ingestion,
  engine: COLORS.engine,
  intelligence: COLORS.intelligence,
  storage: COLORS.storage,
  communication: COLORS.communication,
  flow: COLORS.flow,
};

function StepCard({ step, isActive, isDone, onClick }) {
  const c = LAYER_COLORS[step.layer] || LAYER_COLORS.external;
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 12px",
        borderRadius: 8,
        cursor: "pointer",
        background: isActive ? c.bg : "transparent",
        border: `1.5px solid ${isActive ? c.border : "transparent"}`,
        transition: "all 0.2s",
        marginBottom: 4,
        boxShadow: isActive ? `0 0 10px ${c.border}44` : "none",
      }}
    >
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: isDone ? c.border : isActive ? c.border : "#374151",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: "bold",
          flexShrink: 0,
          marginTop: 1,
        }}
      >
        {isDone ? "✓" : step.id}
      </div>
      <div>
        <div style={{ color: isActive ? c.text : "#9ca3af", fontSize: 12, fontWeight: isActive ? "bold" : "normal" }}>
          {step.title}
        </div>
        {isActive && (
          <div style={{ color: c.text, opacity: 0.7, fontSize: 11, marginTop: 2 }}>{step.detail}</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("arch");
  const [activeStep, setActiveStep] = useState(1);

  const current = E2E_STEPS[activeStep - 1];
  const highlightModule = current?.highlight;

  return (
    <div
      style={{
        background: "#0f0f13",
        minHeight: "100vh",
        color: "#e5e7eb",
        fontFamily: "'Inter', sans-serif",
        padding: "0 0 40px 0",
      }}
    >
      {/* Header */}
      <div
        style={{
          background: "#13131a",
          borderBottom: "1px solid #1f2937",
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ fontSize: 20 }}>⚙️</div>
        <div>
          <div style={{ fontWeight: "bold", fontSize: 15, color: "#f3f4f6" }}>SMB Automation Stack</div>
          <div style={{ fontSize: 11, color: "#6b7280" }}>Architecture & End-to-End Flow Explorer</div>
        </div>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {[
            { key: "arch", label: "Architecture" },
            { key: "e2e", label: "E2E Flow" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                background: tab === t.key ? "#1d4ed8" : "#1f2937",
                color: tab === t.key ? "#fff" : "#9ca3af",
                border: "none",
                borderRadius: 6,
                padding: "6px 14px",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: tab === t.key ? "bold" : "normal",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px" }}>
        {tab === "arch" && (
          <div>
            <div
              style={{
                color: "#6b7280",
                fontSize: 13,
                marginBottom: 20,
                padding: "10px 16px",
                background: "#13131a",
                borderRadius: 8,
                border: "1px solid #1f2937",
              }}
            >
              The system is organized in strict layers. Each layer only communicates downward.
              No module imports another module. All contracts flow through{" "}
              <code style={{ color: "#a78bfa" }}>ModuleResult&lt;T&gt;</code>.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
              <div>
                <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                  Layer Diagram
                </div>
                <ArchDiagram highlightModule={null} />
              </div>

              <div>
                <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
                  Design Principles
                </div>
                {[
                  { icon: "🚫", title: "Modules never import each other", desc: "Zero cross-module dependencies. All wiring happens in the engine." },
                  { icon: "🔁", title: "Sequential, deterministic execution", desc: "Steps run one at a time. No parallel execution. Inputs/conditions must be pure functions." },
                  { icon: "💥", title: "Fail-fast error handling", desc: "First failing step halts the flow. Returns { ok: false, stepId, error } immediately." },
                  { icon: "🗃️", title: "Provider is data, not code", desc: "No hard-coded providers. Provider name travels in step input at runtime." },
                  { icon: "🔒", title: "No throws at module boundary", desc: "Every module catches internally and returns ModuleResult<T>. Engine never sees exceptions." },
                  { icon: "🧠", title: "Business logic lives in flows only", desc: "Engine has no conditionals about what to do. Flows own decisions; engine just executes." },
                  { icon: "📐", title: "Shared canonical contract", desc: "ModuleResult<T> = { ok: true; output } | { ok: false; error }. Every module conforms to this." },
                  { icon: "📁", title: "Context is the single source of truth", desc: "All step outputs accumulate in ctx.outputs[stepId]. Later steps read from earlier outputs." },
                ].map((p) => (
                  <div
                    key={p.title}
                    style={{
                      background: "#13131a",
                      border: "1px solid #1f2937",
                      borderRadius: 8,
                      padding: "10px 14px",
                      marginBottom: 8,
                      display: "flex",
                      gap: 10,
                    }}
                  >
                    <span style={{ fontSize: 16 }}>{p.icon}</span>
                    <div>
                      <div style={{ color: "#f3f4f6", fontSize: 12, fontWeight: "bold" }}>{p.title}</div>
                      <div style={{ color: "#6b7280", fontSize: 11, marginTop: 2 }}>{p.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === "e2e" && (
          <div>
            <div
              style={{
                color: "#6b7280",
                fontSize: 13,
                marginBottom: 20,
                padding: "10px 16px",
                background: "#13131a",
                borderRadius: 8,
                border: "1px solid #1f2937",
              }}
            >
              Trace a single user message <code style={{ color: "#fcd34d" }}>"paid Raj 500"</code> from WhatsApp
              all the way through the system and back. Click any step to inspect it.
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 280px", gap: 20 }}>
              {/* Step list */}
              <div>
                <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>
                  Steps ({E2E_STEPS.length})
                </div>
                {E2E_STEPS.map((s) => (
                  <StepCard
                    key={s.id}
                    step={s}
                    isActive={s.id === activeStep}
                    isDone={s.id < activeStep}
                    onClick={() => setActiveStep(s.id)}
                  />
                ))}
                <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                  <button
                    onClick={() => setActiveStep((p) => Math.max(1, p - 1))}
                    disabled={activeStep === 1}
                    style={{
                      flex: 1,
                      background: "#1f2937",
                      color: activeStep === 1 ? "#4b5563" : "#e5e7eb",
                      border: "none",
                      borderRadius: 6,
                      padding: "7px",
                      cursor: activeStep === 1 ? "not-allowed" : "pointer",
                      fontSize: 13,
                    }}
                  >
                    ← Prev
                  </button>
                  <button
                    onClick={() => setActiveStep((p) => Math.min(E2E_STEPS.length, p + 1))}
                    disabled={activeStep === E2E_STEPS.length}
                    style={{
                      flex: 1,
                      background: "#1d4ed8",
                      color: activeStep === E2E_STEPS.length ? "#4b5563" : "#fff",
                      border: "none",
                      borderRadius: 6,
                      padding: "7px",
                      cursor: activeStep === E2E_STEPS.length ? "not-allowed" : "pointer",
                      fontSize: 13,
                      fontWeight: "bold",
                    }}
                  >
                    Next →
                  </button>
                </div>
              </div>

              {/* Code panel */}
              <div>
                {current && (
                  <div>
                    <div
                      style={{
                        background: LAYER_COLORS[current.layer]?.bg || "#13131a",
                        border: `1.5px solid ${LAYER_COLORS[current.layer]?.border || "#374151"}`,
                        borderRadius: 10,
                        padding: "14px 18px",
                        marginBottom: 12,
                      }}
                    >
                      <div
                        style={{
                          color: LAYER_COLORS[current.layer]?.text || "#e5e7eb",
                          fontWeight: "bold",
                          fontSize: 14,
                          marginBottom: 4,
                        }}
                      >
                        Step {current.id} — {current.title}
                      </div>
                      <div
                        style={{
                          color: LAYER_COLORS[current.layer]?.text || "#9ca3af",
                          opacity: 0.75,
                          fontSize: 12,
                        }}
                      >
                        {current.detail}
                      </div>
                    </div>
                    <div
                      style={{
                        background: "#0d1117",
                        border: "1px solid #21262d",
                        borderRadius: 10,
                        padding: "16px",
                        overflowX: "auto",
                      }}
                    >
                      <pre
                        style={{
                          color: "#e6edf3",
                          fontSize: 12,
                          fontFamily: "'Fira Code', 'Consolas', monospace",
                          lineHeight: 1.6,
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {current.code
                          .split("\n")
                          .map((line, i) => {
                            const isComment = line.trim().startsWith("//");
                            const isKey = /^\s+(ok|type|id|provider|to|message|from|object|entry|text|timestamp|userId|message|intent|party|amount|type):/.test(line);
                            const isString = /"[^"]*"/.test(line) && !isComment;
                            return (
                              <span
                                key={i}
                                style={{
                                  color: isComment ? "#8b949e" : isKey ? "#79c0ff" : "#e6edf3",
                                  display: "block",
                                }}
                              >
                                {line}
                              </span>
                            );
                          })}
                      </pre>
                    </div>
                  </div>
                )}
              </div>

              {/* Architecture mini-map with highlight */}
              <div>
                <div style={{ color: "#6b7280", fontSize: 11, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1 }}>
                  Active Layer
                </div>
                <ArchDiagram highlightModule={highlightModule} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
