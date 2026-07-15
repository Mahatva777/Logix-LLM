import { useState, useEffect, useRef } from "react";
import StockResearchAssistant from "./components/StockResearchAssistant.jsx";
import GeneralResearchAssistant from "./components/GeneralResearchAssistant.jsx";
import PortfolioPage from "./components/PortfolioPage.jsx";
import AdvanceGenerativeUI from "./components/AdvanceGenerativeUI.jsx";

const MODES = [
  { id: "stock", label: "Stock Research" },
  { id: "general", label: "General Research" },
  { id: "portfolio", label: "My Portfolio" },
  { id: "genui", label: "Advance Generative UI", sandbox: true },
];

/* ── Ticker strip helpers ─────────────────────────────────────────── */
const TICKER_NAMES = {
  TCS: "TCS", HDFC: "HDFC Bank", ICICI: "ICICI Bank",
  INFY: "Infosys", RELIANCE: "Reliance",
};

function TickerStrip() {
  const [prices, setPrices] = useState({});
  const stripRef = useRef(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const r = await fetch("/api/prices");
        if (r.ok && active) setPrices(await r.json());
      } catch { /* silent */ }
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const tickers = Object.values(prices).filter((t) => t.price > 0);
  if (tickers.length === 0) return null;

  // Duplicate the list 4x so the scroll loop looks seamless
  const items = [...tickers, ...tickers, ...tickers, ...tickers];

  return (
    <div className="mlx-ticker-bar" ref={stripRef}>
      <div className="mlx-ticker-track">
        {items.map((t, i) => {
          const up = t.changePct >= 0;
          return (
            <span key={`${t.ticker}-${i}`} className="mlx-ticker-item">
              <span className="mlx-ticker-sym">{TICKER_NAMES[t.ticker] || t.ticker}</span>
              <span className="mlx-ticker-price">
                {"\u20B9"}{t.price.toLocaleString("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
              </span>
              <span className={`mlx-ticker-chg ${up ? "mlx-up" : "mlx-down"}`}>
                {up ? "\u25B2" : "\u25BC"} {Math.abs(t.changePct).toFixed(2)}%
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ── Main App ─────────────────────────────────────────────────────── */
export default function App() {
  const [mode, setMode] = useState("stock");

  return (
    <div className="mlx-shell">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');

        :root {
          --mlx-blue-900: #0B1E4D;
          --mlx-blue-700: #1547D6;
          --mlx-blue-500: #2F8CEA;
          --mlx-blue-300: #7FC8F8;
          --mlx-blue-100: #EAF4FE;
          --mlx-line: #E3ECFB;
        }

        *, *::before, *::after { box-sizing: border-box; }
        .mlx-shell { background: #F5F8FF; font-family: 'Inter', sans-serif; min-height: 100vh; }

        /* ── Live Ticker Strip ─────────────────────────────────────── */
        .mlx-ticker-bar {
          width: 100%;
          background: #0B1120;
          overflow: hidden;
          position: relative;
          z-index: 50;
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        /* Fade edges */
        .mlx-ticker-bar::before,
        .mlx-ticker-bar::after {
          content: '';
          position: absolute; top: 0; bottom: 0; width: 60px;
          z-index: 2; pointer-events: none;
        }
        .mlx-ticker-bar::before { left: 0; background: linear-gradient(90deg, #0B1120 0%, transparent 100%); }
        .mlx-ticker-bar::after  { right: 0; background: linear-gradient(270deg, #0B1120 0%, transparent 100%); }

        .mlx-ticker-track {
          display: flex;
          align-items: center;
          gap: 2.5rem;
          white-space: nowrap;
          padding: 0.55rem 0;
          animation: mlx-scroll 35s linear infinite;
          width: max-content;
        }
        .mlx-ticker-bar:hover .mlx-ticker-track { animation-play-state: paused; }

        @keyframes mlx-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }

        .mlx-ticker-item {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 12.5px;
          letter-spacing: 0.01em;
        }
        .mlx-ticker-sym {
          font-family: 'Inter', sans-serif;
          font-weight: 600;
          color: #CBD5E1;
        }
        .mlx-ticker-price {
          font-family: 'JetBrains Mono', monospace;
          font-weight: 500;
          color: #F1F5F9;
        }
        .mlx-ticker-chg {
          font-family: 'JetBrains Mono', monospace;
          font-weight: 500;
          font-size: 11.5px;
          padding: 1px 6px;
          border-radius: 4px;
        }
        .mlx-up  { color: #34D399; background: rgba(52,211,153,0.12); }
        .mlx-down { color: #F87171; background: rgba(248,113,113,0.12); }

        /* Separator dots between items */
        .mlx-ticker-item + .mlx-ticker-item::before {
          content: '\\00B7';
          color: rgba(255,255,255,0.2);
          margin-right: 0.25rem;
          font-size: 18px;
        }

        /* ── Navigation Bar ────────────────────────────────────────── */
        .mlx-nav-wrap { max-width: 72rem; margin: 0 auto; padding: 1rem 1.25rem 0; }
        @media (min-width: 1024px) { .mlx-nav-wrap { padding: 1.25rem 2rem 0; } }

        .mlx-nav {
          display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
          background: #fff; border: 1px solid var(--mlx-line); border-radius: 16px;
          padding: 0.5rem; box-shadow: 0 1px 2px rgba(11,30,77,0.04);
        }

        .mlx-brand {
          font-family: 'Manrope', sans-serif; font-weight: 800; font-size: 1rem;
          letter-spacing: -0.01em; color: var(--mlx-blue-900);
          padding: 0 0.75rem 0 0.5rem; white-space: nowrap;
        }

        .mlx-tabs { display: flex; align-items: center; gap: 0.375rem; flex-wrap: wrap; }

        .mlx-tab {
          font-family: 'Inter', sans-serif; font-weight: 600; font-size: 12.5px;
          letter-spacing: 0.01em; color: var(--mlx-blue-900); background: transparent;
          border: none; border-radius: 10px; padding: 0.5rem 0.9rem; cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .mlx-tab:hover:not(.mlx-tab-active) { background: rgba(21,71,214,0.07); color: var(--mlx-blue-700); }
        .mlx-tab-active {
          background: linear-gradient(120deg, var(--mlx-blue-700), var(--mlx-blue-500));
          color: #fff;
        }

        .mlx-tab-sandbox { border: 1px dashed #C08B2C; }
        .mlx-tab-sandbox:not(.mlx-tab-active) { color: #8a6220; }
        .mlx-tab-sandbox.mlx-tab-active {
          background: linear-gradient(120deg, #8a6220, #C08B2C);
          border-style: solid;
        }
        .mlx-tab-sandbox-dot {
          display: inline-block; width: 6px; height: 6px; border-radius: 999px;
          background: #C08B2C; margin-right: 0.4rem; vertical-align: middle;
        }
        .mlx-tab-sandbox.mlx-tab-active .mlx-tab-sandbox-dot { background: #fff; }
      `}</style>

      {/* Live scrolling ticker strip */}
      <TickerStrip />

      <div className="mlx-nav-wrap">
        <nav className="mlx-nav" aria-label="Assistant mode">
          <span className="mlx-brand">MoneyLogix</span>
          <div className="mlx-tabs" role="tablist">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="tab"
                aria-selected={mode === m.id}
                onClick={() => setMode(m.id)}
                className={`mlx-tab ${m.sandbox ? "mlx-tab-sandbox" : ""} ${mode === m.id ? "mlx-tab-active" : ""}`}
              >
                {m.sandbox && <span className="mlx-tab-sandbox-dot" aria-hidden="true" />}
                {m.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      {mode === "stock" && <StockResearchAssistant />}
      {mode === "general" && <GeneralResearchAssistant />}
      {mode === "portfolio" && <PortfolioPage />}
      {mode === "genui" && <AdvanceGenerativeUI />}
    </div>
  );
}
