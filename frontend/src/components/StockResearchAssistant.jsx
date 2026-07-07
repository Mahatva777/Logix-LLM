import React, { useEffect, useRef, useState, useCallback } from "react";
import { Send, Loader2, ShieldCheck, TrendingUp, TrendingDown } from "lucide-react";

/* ------------------------------------------------------------------ *
 * Design note (kept short, on purpose):
 * This treats the assistant's reply like a printed sell-side research
 * note rather than a chat bubble — serif "Answer" card, an amber
 * margin-note "Considerations" block, footnote-style citation markers,
 * and a rotated "SEBI ADVISORY" stamp on the Note strip. User turns are
 * a plain right-aligned monospace query line, terminal-style. That
 * contrast is the whole differentiator: it should read as a research
 * artifact, not a generic chatbot.
 *
 * Implementation note: the bespoke palette/type-scale below is plain
 * CSS (in the <style> tag) rather than Tailwind arbitrary-value classes
 * like bg-[#12222B], since those need a JIT compiler this environment
 * doesn't run. Tailwind is used only for generic, precompiled layout
 * utilities (flex, grid, gap-*, p-*, rounded, etc.).
 * ------------------------------------------------------------------ */

// ---------------------------------------------------------------------
// Mock fundamentals (static — matches the "5-stock, curated data" scope)
// ---------------------------------------------------------------------
const STOCK = {
  ticker: "TCS",
  name: "Tata Consultancy Services",
  sector: "IT Services",
  cap: "Large Cap",
  price: 4128.4,
  change: 48.6,
  changePct: 1.19,
};

const FUNDAMENTALS = [
  { label: "Market Cap", value: "₹14.92L Cr" },
  { label: "P/E (TTM)", value: "28.4x" },
  { label: "P/B", value: "11.2x" },
  { label: "Dividend Yield", value: "1.3%" },
  { label: "ROE", value: "46.8%" },
  { label: "52W Range", value: "₹3,050 – ₹4,260" },
];

// ---------------------------------------------------------------------
// Offline demo fallback — used only when POST /chat isn't reachable
// (e.g. viewing this component without the FastAPI backend running).
// Mirrors the exact Answer/Considerations/Note contract main.py streams.
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
            <span className="rs-mono rs-eyebrow">Answer</span>
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
          <span className="rs-serif rs-eyebrow-serif uppercase">Answer</span>
          <span className="rs-rule flex-1" />
        </div>
        <p className="rs-body">{renderWithCitations(answer, seen)}</p>
      </div>

      {/* Considerations */}
      {considerations && (
        <div className="rs-considerations">
          <span className="rs-mono rs-eyebrow block mb-1">Considerations</span>
          <p className="rs-considerations-body italic">{renderWithCitations(considerations, seen)}</p>
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
      <div className="rs-msg-max rs-user-msg rs-mono">
        <span className="rs-prompt-mark">&gt;</span>
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------
let _idCounter = 1;
const nextId = () => _idCounter++;

export default function StockResearchAssistant() {
  const [messages, setMessages] = useState(() => {
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
  });
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
        setMessages((prev) => prev.map((m) => (m.id === assistantId ? { ...m, status: "done", sections, sources: resp.sources } : m)));
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
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, ticker: STOCK.ticker }),
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
    sendMessage(input);
  };

  const isUp = STOCK.change >= 0;

  return (
    <div className="rs-root min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

        :root {
          --ink: #12222B;
          --ink-light: #1C3540;
          --paper: #EEF1EC;
          --panel: #F4F6F3;
          --card: #FFFFFF;
          --line: #D8DDD6;
          --text: #16262E;
          --muted: #5C6B6A;
          --jade: #1F7A5C;
          --brick: #B23A2E;
          --bronze: #C08B2C;
          --bronze-dark: #8a6323;
          --amber-bg: #FBF3E3;
          --amber-line: #D8C79A;
          --amber-text: #4a3a1c;
        }

        .rs-root { background: var(--paper); color: var(--text); font-family: 'Inter', sans-serif; }
        .rs-serif { font-family: 'Fraunces', serif; }
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
          .rs-layout { grid-template-columns: 300px 1fr; padding: 2rem; }
        }

        .rs-header { background: var(--ink); color: var(--paper); }
        .rs-ticker-tag { color: #6E8583; border: 1px solid #2A4048; font-size: 10px; }
        .rs-company-name { color: #9BB0AE; }
        .rs-price-up { color: #3FA37D; }
        .rs-price-down { color: #D9695E; }

        .rs-panel { background: var(--card); border: 1px solid var(--line); }
        .rs-panel-title { color: var(--muted); border-bottom: 1px solid var(--line); font-size: 11px; }
        .rs-fund-row + .rs-fund-row { margin-top: 0.75rem; }
        .rs-fund-label { color: var(--muted); font-size: 13px; }
        .rs-fund-value { color: var(--text); font-size: 13px; font-weight: 600; }

        .rs-chat { background: var(--panel); border: 1px solid var(--line); height: 40rem; }
        .rs-chat-header { border-bottom: 1px solid var(--line); }
        .rs-chat-title { color: var(--muted); font-size: 11px; }
        .rs-status { color: var(--muted); font-size: 10px; }
        .rs-status-dot { width: 6px; height: 6px; border-radius: 9999px; display: inline-block; }
        .rs-status-idle { background: #9BA6A4; }
        .rs-status-live { background: var(--jade); }
        .rs-status-demo { background: var(--bronze); }

        .rs-msg-max { max-width: 85%; }
        .rs-user-msg { background: var(--ink); color: var(--paper); border-radius: 2px; padding: 0.5rem 0.875rem; font-size: 13.5px; }
        .rs-prompt-mark { color: var(--bronze); margin-right: 0.375rem; }

        .rs-card { background: var(--card); border: 1px solid var(--line); border-radius: 2px; padding: 0.875rem 1rem; }
        .rs-eyebrow { color: var(--muted); font-size: 10px; letter-spacing: 0.15em; text-transform: uppercase; }
        .rs-eyebrow-serif { color: var(--text); font-size: 13px; letter-spacing: 0.08em; }
        .rs-rule { height: 1px; background: var(--line); }
        .rs-body { font-size: 14.5px; line-height: 1.6; color: var(--text); }
        .rs-cursor { display: inline-block; width: 2px; height: 14px; background: var(--jade); margin-left: 2px; vertical-align: middle; animation: rs-blink 1s step-start infinite; }
        @keyframes rs-blink { 50% { opacity: 0; } }

        .rs-considerations { background: var(--amber-bg); border-left: 3px solid var(--bronze); border-radius: 2px; padding: 0.75rem 1rem; }
        .rs-considerations-body { font-size: 13.5px; line-height: 1.6; color: var(--amber-text); }

        .rs-note { background: rgba(245, 240, 228, 0.7); border-top: 1px dashed var(--amber-line); border-radius: 2px; padding: 0.625rem 0.75rem; }
        .rs-note-text { font-size: 11px; line-height: 1.5; color: #7a6a45; letter-spacing: 0.02em; }

        .rs-stamp { width: 3.5rem; height: 3.5rem; border: 2px dashed var(--bronze); color: var(--bronze-dark); border-radius: 2px; transform: rotate(-4deg); }
        .rs-stamp-text { font-size: 8px; font-weight: 700; letter-spacing: 0.1em; margin-top: 2px; }

        .rs-footnote { font-size: 11px; padding: 0.25rem 0.5rem; border: 1px solid var(--line); border-radius: 2px; background: var(--card); color: var(--muted); transition: color 0.15s, border-color 0.15s; }
        .rs-footnote:hover { border-color: var(--bronze); color: var(--bronze-dark); }
        .rs-tooltip { bottom: 100%; left: 0; margin-bottom: 0.375rem; width: 16rem; border-radius: 2px; background: var(--ink); color: var(--paper); font-size: 11px; line-height: 1.5; padding: 0.625rem; box-shadow: 0 8px 20px rgba(18,34,43,0.25); transition: opacity 0.15s; }
        .rs-tooltip-title { color: var(--bronze); font-size: 10px; margin-bottom: 0.25rem; }
        .rs-tooltip-hover { opacity: 0; pointer-events: none; }
        .group:hover .rs-tooltip-hover { opacity: 1; pointer-events: auto; }
        .rs-tooltip-open { opacity: 1; }

        .rs-citation { margin-left: 1px; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: var(--bronze-dark); font-weight: 600; }

        .rs-error { border: 1px solid rgba(178,58,46,0.3); background: rgba(178,58,46,0.05); border-radius: 2px; padding: 0.75rem 1rem; font-size: 13.5px; color: #8a2b21; }

        .rs-input { border: 1px solid var(--line); border-radius: 2px; font-size: 13.5px; background: var(--card); }
        .rs-input:focus { outline: none; border-color: var(--jade); box-shadow: 0 0 0 3px rgba(31,122,93,0.15); }
        .rs-send { background: var(--ink); color: var(--paper); border-radius: 2px; font-size: 13px; }
        .rs-send:hover:not(:disabled) { background: var(--ink-light); }
        .rs-send:disabled { opacity: 0.4; }

      `}</style>

      {/* Header */}
      <header className="rs-header px-5 sm:px-8 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h1 className="rs-serif text-2xl tracking-tight">{STOCK.ticker}</h1>
          <span className="rs-company-name text-sm">{STOCK.name}</span>
          <span className="rs-mono rs-ticker-tag uppercase tracking-wider rounded-sm px-1.5 py-0.5">
            {STOCK.sector} · {STOCK.cap}
          </span>
        </div>
        <div className="rs-mono flex items-baseline gap-2">
          <span className="text-lg font-semibold">₹{STOCK.price.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
          <span className={`flex items-center gap-1 text-sm ${isUp ? "rs-price-up" : "rs-price-down"}`}>
            {isUp ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {isUp ? "+" : ""}
            {STOCK.change.toFixed(2)} ({isUp ? "+" : ""}
            {STOCK.changePct.toFixed(2)}%)
          </span>
        </div>
      </header>

      {/* Body */}
      <div className="rs-layout">
        {/* Fundamentals panel */}
        <aside className="rs-panel rounded-sm p-5 h-fit">
          <h2 className="rs-mono rs-panel-title uppercase tracking-widest mb-4 pb-2">Fundamentals</h2>
          <dl>
            {FUNDAMENTALS.map((f) => (
              <div key={f.label} className="rs-fund-row flex items-center justify-between">
                <dt className="rs-fund-label">{f.label}</dt>
                <dd className="rs-mono rs-fund-value">{f.value}</dd>
              </div>
            ))}
          </dl>
        </aside>

        {/* Chat panel */}
        <section className="rs-chat rounded-sm flex flex-col">
          <div className="rs-chat-header flex items-center justify-between px-4 py-3">
            <h2 className="rs-mono rs-chat-title uppercase tracking-widest">Research Assistant</h2>
            <span className="rs-mono rs-status flex items-center gap-1.5">
              <span
                className={`rs-status-dot ${
                  backendStatus === "live" ? "rs-status-live" : backendStatus === "demo" ? "rs-status-demo" : "rs-status-idle"
                }`}
              />
              {backendStatus === "live" ? "live" : backendStatus === "demo" ? "demo data" : "idle"}
            </span>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
            {messages.map((m) => (m.role === "user" ? <UserMessage key={m.id} text={m.text} /> : <AssistantMessage key={m.id} msg={m} />))}
          </div>

          <form onSubmit={handleSubmit} className="rs-chat-header p-3 flex gap-2" style={{ borderTop: "1px solid var(--line)", borderBottom: "none" }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about TCS — e.g. Compare HDFC vs ICICI margins"
              disabled={isStreaming}
              className="rs-input flex-1 px-3 py-2"
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
