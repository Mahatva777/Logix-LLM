import React, { useEffect, useRef, useState, useCallback } from "react";
import { Send, Loader2, ShieldCheck, Activity } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

/* ------------------------------------------------------------------ *
 * Design note (kept short, on purpose):
 * This is the "General Research" mode of the same MoneyLogix assistant
 * -- same blue-gradient brand, same header shell, same Answer /
 * Considerations / Note cards, SEBI stamp, and footnote-style citation
 * chips as StockResearchAssistant.jsx. Palette, type-scale, and card
 * structure are unchanged; the <style> block below is copied verbatim
 * from that component plus exactly one additive rule (.rs-layout-solo)
 * for the single-column layout this page needs, since there's no
 * fundamentals panel to sit next to the chat here.
 *
 * What's different from the curated mode: no fixed ticker, no mocked
 * fundamentals -- this mode answers about ANY publicly traded stock via
 * live yfinance tool-calling (general_agent.py on the backend) rather
 * than the curated 5-stock RAG corpus. Ticker tabs and the fundamentals
 * aside are gone, replaced by a free-text input and a "Live Data" badge
 * in the header.
 * ------------------------------------------------------------------ */

// ---------------------------------------------------------------------
// Offline demo fallback — used only when POST /chat/general isn't
// reachable (e.g. viewing this component without the FastAPI backend
// running). Mirrors the exact Answer/Considerations/Note contract
// general_agent.answer_general_query() streams, including its
// "(Source: Yahoo Finance — live data, fetched <date>)" citation shape
// (still matches the same client-side CITATION_RE below). Deliberately
// a single, query-agnostic response -- unlike the curated mode's
// per-topic canned answers, there's no fixed 5-stock corpus here to
// write realistic per-topic placeholders for.
// ---------------------------------------------------------------------
function demoRespond(query) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    answer:
      `I wasn't able to reach live market data just now, so this is a demo response rather than a real lookup for "${query}". ` +
      `When connected, this mode calls out to live pricing, historicals, balance-sheet, and news data for any ticker you ask about ` +
      `(Source: Yahoo Finance — live data, fetched ${today}).`,
    considerations: null,
    note: null,
    sources: [{ file: "Yahoo Finance", snippet: `Live data fetched ${today} via yfinance tool-calling.` }],
    chartData: null,
  };
}

function buildMarkdown({ answer, considerations, note }) {
  let md = `**Answer**\n${answer}`;
  if (considerations) md += `\n\n**Considerations**\n${considerations}`;
  if (note) md += `\n\n**Note**\n${note}`;
  return md;
}

// ---------------------------------------------------------------------
// Section + citation parsing (client-side mirror of guardrails.py)
// ---------------------------------------------------------------------
const SECTION_RE = /^\*\*(Answer|Considerations|Note)\*\*\s*$/gm;
const CITATION_RE = /\(Source:\s*(.+?)\s+[—-]\s+(.+?)\)/g;

function splitSections(markdown) {
  const matches = [...markdown.matchAll(SECTION_RE)];
  if (matches.length === 0) return { answer: markdown.trim(), considerations: null, note: null };
  const found = {};
  matches.forEach((m, i) => {
    const name = m[1].toLowerCase();
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : markdown.length;
    found[name] = markdown.slice(start, end).trim();
  });
  return {
    answer: found.answer || "",
    considerations: found.considerations || null,
    note: found.note || null,
  };
}

function buildFootnotes(texts) {
  const list = [];
  const seen = new Map();
  texts.forEach((text) => {
    if (!text) return;
    const re = new RegExp(CITATION_RE);
    let m;
    while ((m = re.exec(text))) {
      const file = m[1].trim();
      const section = m[2].trim();
      const key = `${file}|${section}`;
      if (!seen.has(key)) {
        seen.set(key, list.length + 1);
        list.push({ n: list.length + 1, file, section });
      }
    }
  });
  return { list, seen };
}

function renderWithCitations(text, seenMap) {
  if (!text) return null;
  const parts = [];
  let lastIndex = 0;
  const re = new RegExp(CITATION_RE);
  let m;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index));
    const file = m[1].trim();
    const section = m[2].trim();
    const n = seenMap.get(`${file}|${section}`);
    parts.push(
      <sup key={`c-${key++}`} className="rs-citation">
        [{n}]
      </sup>
    );
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

// ---------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------
function ComplianceStamp() {
  return (
    <div className="rs-stamp shrink-0 flex flex-col items-center justify-center" aria-hidden="true">
      <ShieldCheck size={14} strokeWidth={2.2} />
      <span className="rs-mono rs-stamp-text">SEBI</span>
    </div>
  );
}

function FootnoteChip({ note, snippet }) {
  const [pinned, setPinned] = useState(false);
  return (
    <span className="relative inline-block group">
      <button type="button" onClick={() => setPinned((p) => !p)} className="rs-mono rs-footnote">
        [{note.n}] {note.file.length > 22 ? note.file.slice(0, 20) + "…" : note.file}
      </button>
      {snippet && (
        <span className={`rs-tooltip absolute z-10 ${pinned ? "rs-tooltip-open" : "rs-tooltip-hover"}`}>
          <span className="rs-mono rs-tooltip-title block">
            {note.file} — {note.section}
          </span>
          {snippet}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------
// Price chart -- rendered inside the Answer card when chart_data is
// present. Styled off the same theme CSS custom properties as the rest
// of the card (--ink, --line, --card, --muted, --blue-*) rather than
// Recharts' default palette, and the rupee formatting matches the
// ₹X,XX,XXX.XX (en-IN, 2 decimals) style used elsewhere in the app.
// ---------------------------------------------------------------------
function formatRupee(value, { decimals = 2 } = {}) {
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function formatChartDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rs-chart-tooltip">
      <span className="rs-mono rs-chart-tooltip-date block">{formatChartDate(label)}</span>
      <span className="rs-mono rs-chart-tooltip-price">{formatRupee(payload[0].value)}</span>
    </div>
  );
}

function PriceChart({ chartData }) {
  if (!chartData || !Array.isArray(chartData.series) || chartData.series.length === 0) return null;
  const { ticker, series } = chartData;

  return (
    <div className="rs-chart-wrap">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="rs-mono rs-chart-ticker">{ticker}</span>
        <span className="rs-chart-sub">Closing price</span>
      </div>
      <div className="rs-chart-canvas">
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={series} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatChartDate}
              tick={{ fontSize: 10, fill: "var(--muted)", fontFamily: "'IBM Plex Mono', monospace" }}
              axisLine={{ stroke: "var(--line)" }}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tickFormatter={(v) => formatRupee(v, { decimals: 0 })}
              tick={{ fontSize: 10, fill: "var(--muted)", fontFamily: "'IBM Plex Mono', monospace" }}
              axisLine={false}
              tickLine={false}
              width={64}
              domain={["auto", "auto"]}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "var(--blue-300)", strokeWidth: 1 }} />
            <Line
              type="monotone"
              dataKey="close"
              stroke="var(--blue-700)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "var(--blue-500)", stroke: "var(--card)", strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function AssistantMessage({ msg }) {
  const streaming = msg.status === "streaming";

  if (streaming) {
    return (
      <div className="rs-msg-max">
        <div className="rs-card">
          <div className="flex items-center gap-2 mb-2">
            <span className="rs-eyebrow">Answer</span>
            <span className="rs-rule flex-1" />
          </div>
          <p className="rs-body whitespace-pre-wrap">
            {msg.rawText}
            <span className="rs-cursor" />
          </p>
        </div>
      </div>
    );
  }

  if (msg.status === "error") {
    return <div className="rs-msg-max rs-error">{msg.errorDetail || "Something went wrong reaching the research assistant."}</div>;
  }

  const { answer, considerations, note } = msg.sections;
  const { list: footnotes, seen } = buildFootnotes([answer, considerations]);
  const snippetFor = (file) => {
    const hit = (msg.sources || []).find((s) => s.file.toLowerCase() === file.toLowerCase());
    return hit ? hit.snippet : null;
  };

  return (
    <div className="rs-msg-max flex flex-col gap-2">
      {/* Answer */}
      <div className="rs-card">
        <div className="flex items-center gap-2 mb-2">
          <span className="rs-eyebrow">Answer</span>
          <span className="rs-rule flex-1" />
        </div>
        <p className="rs-body">{renderWithCitations(answer, seen)}</p>
        <PriceChart chartData={msg.chartData} />
      </div>

      {/* Considerations */}
      {considerations && (
        <div className="rs-considerations">
          <span className="rs-mono rs-eyebrow-alt block mb-1">Considerations</span>
          <p className="rs-considerations-body">{renderWithCitations(considerations, seen)}</p>
        </div>
      )}

      {/* Footnotes */}
      {footnotes.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {footnotes.map((f) => (
            <FootnoteChip key={f.n} note={f} snippet={snippetFor(f.file)} />
          ))}
        </div>
      )}

      {/* Note / compliance strip */}
      {note && (
        <div className="rs-note flex items-center gap-3 mt-1">
          <ComplianceStamp />
          <p className="rs-mono rs-note-text">{note}</p>
        </div>
      )}
    </div>
  );
}

function UserMessage({ text }) {
  return (
    <div className="flex justify-end">
      <div className="rs-msg-max rs-user-msg">{text}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-8">
      <p className="rs-empty-title">Ask about any stock</p>
      <p className="rs-empty-sub">Try "What's Zomato's latest quarterly revenue?" or "How has TSLA moved this month?"</p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------
let _idCounter = 1;
const nextId = () => _idCounter++;

export default function GeneralResearchAssistant() {
  // No seeded conversation here (unlike the curated mode's TCS seed
  // question) -- there's no single "default stock" for a free-text,
  // any-ticker mode, so a clean empty state is the honest starting
  // point. See EmptyState above for the copy shown instead.
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [backendStatus, setBackendStatus] = useState("unknown"); // unknown | live | demo
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const runDemoStream = useCallback((assistantId, query) => {
    setBackendStatus("demo");
    const resp = demoRespond(query);
    const full = buildMarkdown(resp);
    const tokens = full.match(/\S+\s*/g) || [full];
    let i = 0;
    const tick = () => {
      i += 1;
      const partial = tokens.slice(0, i).join("");
      setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, rawText: partial } : m)));
      if (i < tokens.length) {
        setTimeout(tick, 16);
      } else {
        const sections = splitSections(full);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, status: "done", sections, sources: resp.sources, chartData: resp.chartData } : m
          )
        );
        setIsStreaming(false);
      }
    };
    tick();
  }, []);

  const sendMessage = useCallback(
    async (query) => {
      if (!query.trim() || isStreaming) return;
      setIsStreaming(true);
      const userMsg = { id: nextId(), role: "user", text: query };
      const assistantId = nextId();
      const assistantMsg = { id: assistantId, role: "assistant", status: "streaming", rawText: "" };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput("");

      try {
        // No `ticker` field here -- this mode is ticker-free by design;
        // whatever company the question names, general_agent.py's own
        // tool-calling agent resolves it (including the ".NS" suffix
        // judgment call for Indian tickers). See main.py's GeneralChatRequest.
        const res = await fetch("/chat/general", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        setBackendStatus("live");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let rawText = "";
        let sources = [];
        let chartData = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop();
          for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            let event = "message";
            let dataLine = "";
            for (const line of chunk.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
            }
            if (!dataLine) continue;
            const payload = JSON.parse(dataLine);
            if (event === "token") {
              rawText += payload.token;
              const snapshot = rawText;
              setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, rawText: snapshot } : m)));
            } else if (event === "sources") {
              sources = payload.sources || [];
            } else if (event === "chart_data") {
              // Only ever sent when general_agent.py's chart_data was
              // non-null (main.py omits the event entirely otherwise).
              // Parsed into state here; rendering it is a later step.
              chartData = payload.chart_data || null;
            } else if (event === "error") {
              throw new Error(payload.detail || "Stream error");
            }
          }
        }

        const sections = splitSections(rawText);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, status: "done", sections, sources, chartData } : m))
        );
        setIsStreaming(false);
      } catch (err) {
        // No backend reachable (or it errored) — fall back to a canned,
        // still-realistic demo stream so the UI stays fully demoable.
        runDemoStream(assistantId, query);
      }
    },
    [isStreaming, runDemoStream]
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <div className="rs-root min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');

        :root {
          --blue-900: #0B1E4D;
          --blue-700: #1547D6;
          --blue-500: #2F8CEA;
          --blue-300: #7FC8F8;
          --blue-100: #EAF4FE;
          --ink: #101828;
          --muted: #64748B;
          --line: #E1E9F5;
          --panel: #F5F9FF;
          --card: #FFFFFF;
          --amber: #B9790A;
          --amber-bg: #FFF6E4;
          --amber-line: #F0DBA8;
          --amber-text: #6B4B12;
          --green-bg: rgba(22,163,74,0.12);
          --green-text: #158A40;
          --red-bg: rgba(220,38,38,0.12);
          --red-text: #C0362D;
        }

        .rs-root { background: var(--panel); color: var(--ink); font-family: 'Inter', sans-serif; }
        .rs-display { font-family: 'Manrope', sans-serif; }
        .rs-mono, .rs-mono * { font-family: 'IBM Plex Mono', monospace; }

        .rs-layout {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1.25rem;
          padding: 1.25rem;
          max-width: 72rem;
          margin: 0 auto;
        }
        @media (min-width: 1024px) {
          .rs-layout { grid-template-columns: 300px 1fr; padding: 1.5rem 2rem 2rem; }
        }
        /* Additive-only rule for General Research mode: no fundamentals
           aside here, so the chat panel takes the full row instead of
           sharing it with a 300px column. Nothing above is changed. */
        @media (min-width: 1024px) {
          .rs-layout-solo { grid-template-columns: 1fr; }
        }

        /* ---------------- Header ---------------- */
        .rs-header-wrap { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1.25rem 0; }
        @media (min-width: 1024px) { .rs-header-wrap { padding: 2rem 2rem 0; } }

        .rs-header { background: var(--card); border: 1px solid var(--line); border-radius: 20px; position: relative; overflow: hidden; }
        .rs-header::before {
          content: "";
          position: absolute; top: 0; left: 0; right: 0; height: 4px;
          background: linear-gradient(90deg, var(--blue-700), var(--blue-300));
        }
        .rs-header-top { padding: 1.25rem 1.5rem 1rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }
        .rs-header-tabs-row { padding: 0.75rem 1.5rem; background: var(--panel); border-top: 1px solid var(--line); }

        .rs-ticker-wrap { position: relative; display: inline-flex; align-items: center; padding: 0.25rem 0.5rem 0.25rem 0; }
        .rs-ticker-halo {
          position: absolute; inset: -14px -10px auto -18px; height: 68px; width: 140px;
          background: radial-gradient(circle, var(--blue-300) 0%, var(--blue-500) 55%, transparent 75%);
          filter: blur(16px); opacity: 0.5; z-index: 0; border-radius: 50%; pointer-events: none;
        }
        .rs-ticker-word {
          position: relative; z-index: 1;
          font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 1.65rem; letter-spacing: -0.02em;
          background: linear-gradient(120deg, var(--blue-700), var(--blue-500) 65%, var(--blue-300));
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        .rs-company-name { color: var(--muted); font-size: 0.875rem; }
        .rs-ticker-tag { color: var(--blue-700); background: var(--blue-100); font-size: 10px; font-weight: 600; }

        .rs-price-value { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 1.1rem; color: var(--ink); }
        .rs-price-change { font-family: 'IBM Plex Mono', monospace; font-size: 0.8rem; padding: 0.2rem 0.55rem; border-radius: 999px; }
        .rs-price-up { background: var(--green-bg); color: var(--green-text); }
        .rs-price-down { background: var(--red-bg); color: var(--red-text); }

        .rs-tab {
          font-family: 'Inter', sans-serif; font-weight: 600; font-size: 12.5px; letter-spacing: 0.02em;
          color: var(--muted); background: transparent; border: none; border-radius: 999px;
          padding: 0.4rem 0.9rem; cursor: pointer; transition: background 0.15s, color 0.15s;
        }
        .rs-tab:hover:not(:disabled):not(.rs-tab-active) { background: rgba(21,71,214,0.07); color: var(--blue-700); }
        .rs-tab:disabled { cursor: not-allowed; opacity: 0.6; }
        .rs-tab-active { background: linear-gradient(120deg, var(--blue-700), var(--blue-500)); color: #fff; }

        /* ---------------- Panels ---------------- */
        .rs-panel { background: var(--card); border: 1px solid var(--line); }
        .rs-panel-title { color: var(--blue-700); border-bottom: 2px solid var(--blue-100); font-size: 11px; font-weight: 700; }
        .rs-fund-row + .rs-fund-row { margin-top: 0.75rem; }
        .rs-fund-label { color: var(--muted); font-size: 13px; }
        .rs-fund-value { color: var(--ink); font-size: 13px; font-weight: 600; }

        .rs-chat { background: var(--card); border: 1px solid var(--line); height: 40rem; }
        .rs-chat-header { border-bottom: 1px solid var(--line); }
        .rs-chat-title { color: var(--blue-700); font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
        .rs-status { color: var(--muted); font-size: 10px; }
        .rs-status-dot { width: 6px; height: 6px; border-radius: 9999px; display: inline-block; }
        .rs-status-idle { background: #B7C2D0; }
        .rs-status-live { background: var(--blue-500); }
        .rs-status-demo { background: var(--amber); }

        .rs-empty-title { font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 15px; color: var(--ink); }
        .rs-empty-sub { font-size: 13px; color: var(--muted); }

        .rs-chat { background: var(--card); border: 1px solid var(--line); height: min(40rem, calc(100vh - 12rem)); max-width: 100%; overflow: hidden; }
        .rs-msg-max { width: fit-content; max-width: min(85%, 42rem); min-width: 0; }
        .rs-user-msg { background: linear-gradient(120deg, var(--blue-700), var(--blue-500)); color: #fff; border-radius: 16px 16px 4px 16px; padding: 0.625rem 1rem; font-size: 13.5px; line-height: 1.5; overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }

        .rs-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1rem 1.125rem; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; }
        .rs-eyebrow { color: var(--blue-700); font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
        .rs-eyebrow-alt { color: var(--amber-text); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; }
        .rs-rule { height: 1px; background: var(--line); }
        .rs-body { font-size: 14.5px; line-height: 1.65; color: var(--ink); overflow-wrap: anywhere; word-break: break-word; white-space: pre-wrap; }
        .rs-cursor { display: inline-block; width: 2px; height: 14px; background: var(--blue-500); margin-left: 2px; vertical-align: middle; animation: rs-blink 1s step-start infinite; }
        @keyframes rs-blink { 50% { opacity: 0; } }

        /* Price chart -- lives inside the Answer card, so it borrows the
           card's own rhythm (rs-eyebrow-style ticker label, rs-line
           grid/axis color, rs-mono for numerics) instead of looking like
           a separate widget. */
        .rs-chart-wrap { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px dashed var(--line); max-width: 100%; overflow: hidden; }
        .rs-chart-ticker { color: var(--blue-700); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
        .rs-chart-sub { color: var(--muted); font-size: 11.5px; }
        .rs-chart-canvas { margin-left: -0.5rem; max-width: 100%; overflow: hidden; }
        .rs-chart-tooltip { background: var(--blue-900); color: #fff; border-radius: 8px; padding: 0.5rem 0.65rem; font-size: 11px; line-height: 1.5; box-shadow: 0 12px 24px rgba(11,30,77,0.25); }
        .rs-chart-tooltip-date { color: var(--blue-300); font-size: 10px; margin-bottom: 0.15rem; }
        .rs-chart-tooltip-price { font-weight: 600; }

        .rs-considerations { background: var(--amber-bg); border-left: 3px solid var(--amber); border-radius: 4px 12px 12px 4px; padding: 0.875rem 1rem; }
        .rs-considerations-body { font-size: 13.5px; line-height: 1.6; color: var(--amber-text); }

        .rs-note { background: var(--blue-100); border-top: 1px dashed var(--blue-300); border-radius: 12px; padding: 0.75rem 0.875rem; }
        .rs-note-text { font-size: 11px; line-height: 1.5; color: var(--blue-900); letter-spacing: 0.01em; }

        .rs-stamp { width: 3.25rem; height: 3.25rem; border: 2px dashed var(--blue-500); color: var(--blue-700); border-radius: 10px; transform: rotate(-4deg); }
        .rs-stamp-text { font-size: 8px; font-weight: 700; letter-spacing: 0.1em; margin-top: 2px; }

        .rs-footnote { font-size: 11px; padding: 0.3rem 0.6rem; border: 1px solid var(--line); border-radius: 999px; background: var(--card); color: var(--muted); transition: color 0.15s, border-color 0.15s; }
        .rs-footnote:hover { border-color: var(--blue-500); color: var(--blue-700); }
        .rs-tooltip { bottom: 100%; left: 0; margin-bottom: 0.375rem; width: 16rem; border-radius: 10px; background: var(--blue-900); color: #fff; font-size: 11px; line-height: 1.5; padding: 0.625rem 0.75rem; box-shadow: 0 12px 24px rgba(11,30,77,0.25); transition: opacity 0.15s; }
        .rs-tooltip-title { color: var(--blue-300); font-size: 10px; margin-bottom: 0.25rem; }
        .rs-tooltip-hover { opacity: 0; pointer-events: none; }
        .group:hover .rs-tooltip-hover { opacity: 1; pointer-events: auto; }
        .rs-tooltip-open { opacity: 1; }

        .rs-citation { margin-left: 1px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--blue-700); font-weight: 600; }

        .rs-error { border: 1px solid rgba(192,54,45,0.3); background: rgba(192,54,45,0.06); border-radius: 12px; padding: 0.75rem 1rem; font-size: 13.5px; color: #8a2b21; }

        .rs-input { border: 1px solid var(--line); border-radius: 999px; font-size: 13.5px; background: var(--card); }
        .rs-input:focus { outline: none; border-color: var(--blue-500); box-shadow: 0 0 0 3px rgba(47,140,234,0.15); }
        .rs-send { background: linear-gradient(120deg, var(--blue-700), var(--blue-500)); color: #fff; border-radius: 999px; font-size: 13px; }
        .rs-send:hover:not(:disabled) { filter: brightness(1.06); }
        .rs-send:disabled { opacity: 0.4; }

      `}</style>

      {/* Header */}
      <div className="rs-header-wrap">
        <header className="rs-header">
          <div className="rs-header-top">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="rs-ticker-wrap">
                <span className="rs-ticker-halo" aria-hidden="true" />
                <span className="rs-ticker-word">General Research</span>
              </span>
              <span className="rs-company-name">Any ticker, live from the market</span>
            </div>
            {/* "Live Data" badge -- replaces the price/fundamentals panel
                since there's no single fixed ticker in this mode; it just
                signals that answers are grounded in live yfinance data
                rather than the curated 5-stock document corpus. */}
            <span className="rs-ticker-tag uppercase tracking-wider rounded-full px-2.5 py-1 flex items-center gap-1.5 w-fit">
              <Activity size={11} />
              Live Data
            </span>
          </div>
        </header>
      </div>

      {/* Body */}
      <div className="rs-layout rs-layout-solo">
        {/* Chat panel */}
        <section className="rs-chat rounded-2xl flex flex-col">
          <div className="rs-chat-header flex items-center justify-between px-4 py-3">
            <h2 className="rs-chat-title uppercase tracking-widest">Research Assistant</h2>
            <span className="rs-mono rs-status flex items-center gap-1.5">
              <span
                className={`rs-status-dot ${
                  backendStatus === "live" ? "rs-status-live" : backendStatus === "demo" ? "rs-status-demo" : "rs-status-idle"
                }`}
              />
              {backendStatus === "live" ? "live" : backendStatus === "demo" ? "demo data" : "idle"}
            </span>
          </div>

          {messages.length === 0 ? (
            <EmptyState />
          ) : (
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
              {messages.map((m) => (m.role === "user" ? <UserMessage key={m.id} text={m.text} /> : <AssistantMessage key={m.id} msg={m} />))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="rs-chat-header p-3 flex gap-2" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about any stock — e.g. What's Zomato's latest quarterly revenue?"
              disabled={isStreaming}
              className="rs-input flex-1 px-4 py-2"
            />
            <button type="submit" disabled={isStreaming || !input.trim()} className="rs-send flex items-center gap-1.5 px-4 py-2 font-medium">
              {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}