import { useState } from "react";
import StockResearchAssistant from "./components/StockResearchAssistant.jsx";
import GeneralResearchAssistant from "./components/GeneralResearchAssistant.jsx";
import PortfolioPage from "./components/PortfolioPage.jsx";

// Top-level mode switcher. Purely navigational: each mode's component is
// unchanged from prior steps (StockResearchAssistant still hits /chat and
// boots into TCS, GeneralResearchAssistant still hits /chat/general,
// PortfolioPage still owns its own load/save + eventual /chat/portfolio
// wiring). Swapping `mode` just changes which one is mounted -- no route
// library, no page reload, no props threaded into any of them.
//
// NOT done here, on purpose (out of scope for "purely routing/navigation"):
//   - Wiring PortfolioPage's chat to a real /chat/portfolio endpoint --
//     that's the streaming-pattern backend work called out separately.
//   - Per-stock URLs (/stocks/:ticker) via react-router, per the note this
//     file already had -- still a separate enhancement, still not needed
//     just to switch between three modes client-side.
//
// Each mode component renders its own full rs-header internally, so this
// nav is deliberately a slim strip that sits above all three, reusing the
// same --blue-* tokens and the rs-tab/rs-tab-active pill pattern already
// established by StockResearchAssistant's own ticker switcher -- not a
// second competing header, and not a generic browser-style navbar.
const MODES = [
  { id: "stock", label: "Stock Research" },
  { id: "general", label: "General Research" },
  { id: "portfolio", label: "My Portfolio" },
];

export default function App() {
  const [mode, setMode] = useState("stock");

  return (
    <div className="mlx-shell min-h-screen w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@700;800&family=Inter:wght@500;600;700&display=swap');

        :root {
          --mlx-blue-900: #0B1E4D;
          --mlx-blue-700: #1547D6;
          --mlx-blue-500: #2F8CEA;
          --mlx-blue-300: #7FC8F8;
          --mlx-blue-100: #EAF4FE;
          --mlx-line: #E3ECFB;
        }

        .mlx-shell { background: #F5F8FF; font-family: 'Inter', sans-serif; }

        .mlx-nav-wrap { max-width: 72rem; margin: 0 auto; padding: 1.25rem 1.25rem 0; }
        @media (min-width: 1024px) { .mlx-nav-wrap { padding: 1.5rem 2rem 0; } }

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
      `}</style>

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
                className={`mlx-tab ${mode === m.id ? "mlx-tab-active" : ""}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      {mode === "stock" && <StockResearchAssistant />}
      {mode === "general" && <GeneralResearchAssistant />}
      {mode === "portfolio" && <PortfolioPage />}
    </div>
  );
}
