import React, { useEffect, useRef, useState, useCallback } from "react";
import { Send, Loader2, ShieldCheck, TrendingUp, TrendingDown } from "lucide-react";

/* ------------------------------------------------------------------ *
 * Design note (kept short, on purpose):
 * Reskinned to MoneyLogix's own blue-gradient brand (bold gradient
 * wordmark, soft blue "blob" halo, clean white space) instead of the
 * previous dark ink/jade/bronze "sell-side note" palette. The signature
 * moment is scaled down on purpose: the real site's big hero blob works
 * because a landing page has acres of white space to stage it in; a
 * compact app header does not, so the callback here is a soft gradient
 * halo behind the ticker word plus a thin gradient accent bar, not a
 * literal oversized blob competing with the price/tabs for attention.
 * Structurally unchanged: Answer / Considerations / Note cards, the
 * SEBI stamp, and footnote-style citation chips are all still here —
 * this is a surface/color reskin, not a rebuild.
 *
 * Implementation note: the palette/type-scale below is plain CSS (in
 * the <style> tag) rather than Tailwind arbitrary-value classes like
 * bg-[#1547D6], since those need a JIT compiler this environment
 * doesn't run. Tailwind is used only for generic, precompiled layout
 * utilities (flex, grid, gap-*, p-*, rounded, etc.).
 * ------------------------------------------------------------------ */

// ---------------------------------------------------------------------
// Mock fundamentals for all 5 stocks (static — matches the "5-stock,
// curated data" hackathon scope). Only TCS's numbers are "real" in the
// sense of matching earlier demo copy; the other 4 are plausible
// placeholders in the same shape/style — UI display values only, not
// data-integrity critical.
// ---------------------------------------------------------------------
const STOCKS = {
  TCS: {
    ticker: "TCS",
    name: "Tata Consultancy Services",
    sector: "IT Services",
    cap: "Large Cap",
    price: 4128.40,
    change: 48.60,
    changePct: 1.19,
    fundamentals: [
      { label: "Market Cap", value: "₹14.92L Cr" },
      { label: "P/E (TTM)", value: "28.4x" },
      { label: "P/B", value: "11.2x" },
      { label: "Dividend Yield", value: "1.3%" },
      { label: "ROE", value: "46.8%" },
      { label: "52W Range", value: "₹3,050 – ₹4,260" },
    ],
  },
  HDFC: {
    ticker: "HDFC",
    name: "HDFC Bank",
    sector: "Private Bank",
    cap: "Large Cap",
    price: 1642.75,
    change: -8.20,
    changePct: -0.50,
    fundamentals: [
      { label: "Market Cap", value: "₹12.84L Cr" },
      { label: "P/E (TTM)", value: "19.6x" },
      { label: "P/B", value: "2.9x" },
      { label: "Dividend Yield", value: "1.1%" },
      { label: "ROE", value: "17.2%" },
      { label: "52W Range", value: "₹1,410 – ₹1,880" },
    ],
  },
  ICICI: {
    ticker: "ICICI",
    name: "ICICI Bank",
    sector: "Private Bank",
    cap: "Large Cap",
    price: 1218.30,
    change: 14.10,
    changePct: 1.17,
    fundamentals: [
      { label: "Market Cap", value: "₹8.61L Cr" },
      { label: "P/E (TTM)", value: "18.2x" },
      { label: "P/B", value: "3.1x" },
      { label: "Dividend Yield", value: "0.8%" },
      { label: "ROE", value: "18.4%" },
      { label: "52W Range", value: "₹1,015 – ₹1,340" },
    ],
  },
  INFY: {
    ticker: "INFY",
    name: "Infosys",
    sector: "IT Services",
    cap: "Large Cap",
    price: 1542.90,
    change: -6.35,
    changePct: -0.41,
    fundamentals: [
      { label: "Market Cap", value: "₹6.41L Cr" },
      { label: "P/E (TTM)", value: "24.1x" },
      { label: "P/B", value: "7.8x" },
      { label: "Dividend Yield", value: "2.4%" },
      { label: "ROE", value: "31.2%" },
      { label: "52W Range", value: "₹1,290 – ₹1,720" },
    ],
  },
  RELIANCE: {
    ticker: "RELIANCE",
    name: "Reliance Industries",
    sector: "Conglomerate",
    cap: "Large Cap",
    price: 2984.15,
    change: 22.80,
    changePct: 0.77,
    fundamentals: [
      { label: "Market Cap", value: "₹20.18L Cr" },
      { label: "P/E (TTM)", value: "22.7x" },
      { label: "P/B", value: "2.2x" },
      { label: "Dividend Yield", value: "0.4%" },
      { label: "ROE", value: "9.6%" },
      { label: "52W Range", value: "₹2,530 – ₹3,215" },
    ],
  },
};

const TICKER_ORDER = ["TCS", "HDFC", "ICICI", "INFY", "RELIANCE"];

// ---------------------------------------------------------------------
// Offline demo fallback — used only when POST /chat isn't reachable
// (e.g. viewing this component without the FastAPI backend running).
// Mirrors the exact Answer/Considerations/Note contract main.py streams.
// Left ticker-agnostic on purpose: these are keyed off query phrasing,
// not the active tab, so they stay meaningful no matter which stock is
// selected when the backend happens to be unreachable.
// ---------------------------------------------------------------------
const DEMO_RESPONSES = [
  {
    match: (q) => /summar|latest result/i.test(q),
    answer:
      "TCS reported Q4 FY26 revenue of ₹64,890 crore, up 8.2% year-on-year, with constant-currency growth of 6.4% (Source: TCS-Q4-FY26-Results.pdf — Financial Highlights). Net profit margin held at 19.1%, broadly flat versus the prior quarter (Source: TCS-Q4-FY26-Results.pdf — Profitability). BFSI and North America were called out as the primary growth drivers for the quarter (Source: TCS-Q4-FY26-Results.pdf — Segment Performance).",
    considerations: null,
    note: null,
    sources: [
      { file: "TCS-Q4-FY26-Results.pdf", snippet: "Revenue for the quarter stood at ₹64,890 crore, a growth of 8.2% YoY..." },
      { file: "TCS-Q4-FY26-Results.pdf", snippet: "Net margin was steady at 19.1%, in line with the prior quarter..." },
    ],
  },
  {
    match: (q) => /(compare|vs\.?|versus)/i.test(q) && /(hdfc|icici)/i.test(q),
    answer:
      "HDFC Bank reported a net interest margin of 3.4% for Q4 FY26 (Source: HDFC-Bank-Q4-FY26-Results.pdf — Key Ratios), while ICICI Bank reported a net interest margin of 4.3% over the same period (Source: ICICI-Bank-Q4-FY26-Results.pdf — Key Ratios). ICICI's margin has been supported by a higher share of retail and unsecured lending, per its own investor presentation (Source: ICICI-Bank-Investor-Presentation-Q4FY26.pdf — Loan Mix).",
    considerations:
      "Both filings flag asset-quality watch items: HDFC notes continued integration costs from its merger weighing on near-term margins (Source: HDFC-Bank-Q4-FY26-Results.pdf — Management Commentary), while ICICI flags unsecured retail lending as a segment it is monitoring closely amid rising system-wide delinquencies (Source: ICICI-Bank-Investor-Presentation-Q4FY26.pdf — Risk Factors).",
    note: null,
    sources: [
      { file: "HDFC-Bank-Q4-FY26-Results.pdf", snippet: "Net interest margin for the quarter was 3.4%, impacted by merger-related costs..." },
      { file: "ICICI-Bank-Q4-FY26-Results.pdf", snippet: "Net interest margin improved to 4.3%, driven by retail and unsecured growth..." },
      { file: "ICICI-Bank-Investor-Presentation-Q4FY26.pdf", snippet: "Unsecured retail book grew, a segment we continue to monitor closely given..." },
    ],
  },
  {
    match: (q) => /(should i|good (buy|time)|worth (it|buying)|hold|recommend)/i.test(q),
    answer:
      "The retrieved context doesn't contain a house view on whether to buy, sell, or hold TCS. What it does show: revenue grew 8.2% YoY in Q4 FY26 and margins held at 19.1% (Source: TCS-Q4-FY26-Results.pdf — Financial Highlights), with management citing steady BFSI demand as a forward driver (Source: TCS-Annual-Report-FY25.pdf — Outlook).",
    considerations:
      "The annual report flags currency volatility and discretionary IT-spend slowdowns in key export markets as watch items for the coming year (Source: TCS-Annual-Report-FY25.pdf — Risk Factors). Liquidity on the counter is high given its large-cap, index-heavy free float (Source: TCS-Annual-Report-FY25.pdf — Shareholding Pattern).",
    note: "This is for informational purposes only and is not investment advice. Please consult a SEBI-registered investment advisor before making investment decisions.",
    sources: [
      { file: "TCS-Q4-FY26-Results.pdf", snippet: "Revenue for the quarter stood at ₹64,890 crore, a growth of 8.2% YoY..." },
      { file: "TCS-Annual-Report-FY25.pdf", snippet: "Currency volatility and discretionary spend slowdowns remain key watch items..." },
      { file: "TCS-Annual-Report-FY25.pdf", snippet: "The stock continues to see high liquidity given its index weight..." },
    ],
  },
];

function demoRespond(query) {
  const hit = DEMO_RESPONSES.find((r) => r.match(query));
  if (!hit) {
    return { answer: "I don't have information on that.", considerations: null, note: null, sources: [] };
  }
  return hit;
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

function EmptyState({ stockName }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-1.5 px-8">
      <p className="rs-empty-title">Ask about {stockName}</p>
      <p className="rs-empty-sub">Try "Summarise the latest results" or "Compare HDFC vs ICICI margins"</p>
    </div>
  );
}

function TickerTabs({ activeTicker, onChange, disabled }) {
  return (
    <div className="rs-tabs flex items-center gap-1.5 flex-wrap">
      {TICKER_ORDER.map((t) => (
        <button
          key={t}
          type="button"
          disabled={disabled}
          onClick={() => onChange(t)}
          className={`rs-tab ${t === activeTicker ? "rs-tab-active" : ""}`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------
let _idCounter = 1;
const nextId = () => _idCounter++;

function seedMessages() {
  const seedQuery = "Should I hold TCS given its margins right now?";
  const seedResp = demoRespond(seedQuery);
  return [
    { id: nextId(), role: "user", text: seedQuery },
    {
      id: nextId(),
      role: "assistant",
      status: "done",
      sections: { answer: seedResp.answer, considerations: seedResp.considerations, note: seedResp.note },
      sources: seedResp.sources,
    },
  ];
}

export default function StockResearchAssistant() {
  const [activeTicker, setActiveTicker] = useState("TCS");
  const [messages, setMessages] = useState(seedMessages);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [backendStatus, setBackendStatus] = useState("unknown"); // unknown | live | demo
  const scrollRef = useRef(null);

  const activeStock = STOCKS[activeTicker];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Switching stocks clears the conversation rather than reseeding it with
  // canned per-ticker Q&A -- the demo fallback data is intentionally
  // ticker-agnostic (see DEMO_RESPONSES above), so a fabricated "seed
  // question" for HDFC/ICICI/INFY/RELIANCE would either repeat the TCS
  // example verbatim (misleading) or require hand-written canned answers
  // for 4 more stocks (not worth it for placeholder UI data). A clean
  // empty state with a ticker-aware prompt is the honest middle ground.
  const handleTickerChange = useCallback(
    (ticker) => {
      if (ticker === activeTicker || isStreaming) return;
      setActiveTicker(ticker);
      setMessages([]);
      setInput("");
    },
    [activeTicker, isStreaming]
  );

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
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, status: "done", sections, sources: resp.sources } : m)));
        setIsStreaming(false);
      }
    };
    tick();
  }, []);

  const sendMessage = useCallback(
    async (query, ticker) => {
      if (!query.trim() || isStreaming) return;
      setIsStreaming(true);
      const userMsg = { id: nextId(), role: "user", text: query };
      const assistantId = nextId();
      const assistantMsg = { id: assistantId, role: "assistant", status: "streaming", rawText: "" };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setInput("");

      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `ticker` is the active tab's stock -- a HINT for retrieval,
          // not a strict filter. If the query itself names other
          // tickers (e.g. "Compare HDFC vs ICICI margins"), the backend
          // gives that precedence over this value; see rag_engine.py's
          // retrieve(). We still send it because for queries that don't
          // name a company, it's the best signal of what "it"/"the
          // stock" refers to.
          body: JSON.stringify({ query, ticker }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        setBackendStatus("live");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let rawText = "";
        let sources = [];

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
            } else if (event === "error") {
              throw new Error(payload.detail || "Stream error");
            }
          }
        }

        const sections = splitSections(rawText);
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, status: "done", sections, sources } : m)));
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
    sendMessage(input, activeTicker);
  };

  const isUp = activeStock.change >= 0;

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

        .rs-msg-max { max-width: 85%; }
        .rs-user-msg { background: linear-gradient(120deg, var(--blue-700), var(--blue-500)); color: #fff; border-radius: 16px 16px 4px 16px; padding: 0.625rem 1rem; font-size: 13.5px; line-height: 1.5; }

        .rs-card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 1rem 1.125rem; }
        .rs-eyebrow { color: var(--blue-700); font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
        .rs-eyebrow-alt { color: var(--amber-text); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; }
        .rs-rule { height: 1px; background: var(--line); }
        .rs-body { font-size: 14.5px; line-height: 1.65; color: var(--ink); }
        .rs-cursor { display: inline-block; width: 2px; height: 14px; background: var(--blue-500); margin-left: 2px; vertical-align: middle; animation: rs-blink 1s step-start infinite; }
        @keyframes rs-blink { 50% { opacity: 0; } }

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
                <span className="rs-ticker-word">{activeStock.ticker}</span>
              </span>
              <span className="rs-company-name">{activeStock.name}</span>
              <span className="rs-ticker-tag uppercase tracking-wider rounded-full px-2.5 py-1">
                {activeStock.sector} · {activeStock.cap}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="rs-price-value">
                ₹{activeStock.price.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
              </span>
              <span className={`rs-price-change flex items-center gap-1 ${isUp ? "rs-price-up" : "rs-price-down"}`}>
                {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {isUp ? "+" : ""}
                {activeStock.change.toFixed(2)} ({isUp ? "+" : ""}
                {activeStock.changePct.toFixed(2)}%)
              </span>
            </div>
          </div>
          <div className="rs-header-tabs-row">
            <TickerTabs activeTicker={activeTicker} onChange={handleTickerChange} disabled={isStreaming} />
          </div>
        </header>
      </div>

      {/* Body */}
      <div className="rs-layout">
        {/* Fundamentals panel */}
        <aside className="rs-panel rounded-2xl p-5 h-fit">
          <h2 className="rs-panel-title uppercase tracking-widest mb-4 pb-2">Fundamentals</h2>
          <dl>
            {activeStock.fundamentals.map((f) => (
              <div key={f.label} className="rs-fund-row flex items-center justify-between">
                <dt className="rs-fund-label">{f.label}</dt>
                <dd className="rs-mono rs-fund-value">{f.value}</dd>
              </div>
            ))}
          </dl>
        </aside>

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
            <EmptyState stockName={activeStock.name} />
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
              placeholder={`Ask about ${activeStock.name} — e.g. Compare HDFC vs ICICI margins`}
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