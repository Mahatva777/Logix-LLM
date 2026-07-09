import React, { useEffect, useState, useCallback } from "react";
import { Plus, Trash2 } from "lucide-react";

/* ------------------------------------------------------------------ *
 * Design note (kept short, on purpose):
 * "My Portfolio" mode for the same MoneyLogix assistant -- same blue-
 * gradient brand, same header shell, same rs-panel/rs-card/rs-input/
 * rs-send patterns as StockResearchAssistant.jsx. The <style> block
 * below is copied verbatim from that component (fonts, :root palette,
 * header, panel, input, button rules) plus a handful of additive-only
 * rules for the pieces that component didn't need yet: a select input,
 * labeled form fields, and a data table. Nothing existing is changed --
 * new rules only, same naming convention (rs-*).
 *
 * Scoped to the 5 curated stocks on purpose (TCS, HDFC, ICICI, INFY,
 * RELIANCE match rag_engine.py's curated corpus) -- this page tracks
 * positions in stocks the assistant actually has research on, not any
 * ticker (that's General Research mode's job).
 * ------------------------------------------------------------------ */

const CURATED_STOCKS = [
  { ticker: "TCS", name: "Tata Consultancy Services" },
  { ticker: "HDFC", name: "HDFC Bank" },
  { ticker: "ICICI", name: "ICICI Bank" },
  { ticker: "INFY", name: "Infosys" },
  { ticker: "RELIANCE", name: "Reliance Industries" },
];

// ---------------------------------------------------------------------
// Persistence stubs
//
// Entries live in React state only for now -- these two functions are
// the entire surface a future backend integration needs to fill in.
// Both are async (return Promises) even though there's nothing to
// await yet, so swapping the body for a real fetch() later doesn't
// change how the component calls them.
//
//   loadPortfolio(): Promise<PortfolioEntry[]>
//   savePortfolio(entries: PortfolioEntry[]): Promise<PortfolioEntry[]>
//
// PortfolioEntry shape:
//   { id, ticker, buyDate, buyPrice, quantity, currentPrice, unrealizedPnlPct }
// currentPrice/unrealizedPnlPct stay null until a backend fills them in
// (next step); everything else is set at entry-creation time.
// ---------------------------------------------------------------------

const PORTFOLIO_STORAGE_KEY = "moneylogix-portfolio";

function loadPortfolio() {
  if (typeof window === "undefined") return Promise.resolve([]);

  try {
    const raw = window.localStorage.getItem(PORTFOLIO_STORAGE_KEY);
    if (!raw) return Promise.resolve([]);
    const parsed = JSON.parse(raw);
    return Promise.resolve(Array.isArray(parsed) ? parsed : []);
  } catch (error) {
    console.warn("Unable to load portfolio from storage", error);
    return Promise.resolve([]);
  }
}

function savePortfolio(entries) {
  if (typeof window === "undefined") return Promise.resolve(entries);

  try {
    window.localStorage.setItem(PORTFOLIO_STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    console.warn("Unable to save portfolio to storage", error);
  }

  return Promise.resolve(entries);
}

// ---------------------------------------------------------------------
// Formatting helpers -- same ₹X,XX,XXX.XX (en-IN, 2 decimals) style
// used elsewhere in the app.
// ---------------------------------------------------------------------
function formatRupee(value) {
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

let _idCounter = 1;
const nextId = () => _idCounter++;

const EMPTY_FORM = { ticker: CURATED_STOCKS[0].ticker, buyDate: "", buyPrice: "", quantity: "" };

function validateForm(form) {
  const errors = {};
  if (!form.ticker) errors.ticker = "Pick a ticker.";
  if (!form.buyDate) errors.buyDate = "Pick a buy date.";
  const price = Number(form.buyPrice);
  if (!form.buyPrice || Number.isNaN(price) || price <= 0) errors.buyPrice = "Enter a price above 0.";
  const qty = Number(form.quantity);
  if (!form.quantity || Number.isNaN(qty) || qty <= 0) errors.quantity = "Enter a quantity above 0.";
  return errors;
}

// ---------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------
function FieldLabel({ children }) {
  return <label className="rs-field-label">{children}</label>;
}

function EmptyHoldings() {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-1.5 px-8 py-10">
      <p className="rs-empty-title">No positions logged yet</p>
      <p className="rs-empty-sub">Add your first trade using the form above.</p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------
export default function PortfolioPage() {
  const [holdings, setHoldings] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState({});
  const [loading, setLoading] = useState(true);

  // Hydrate from loadPortfolio() on mount -- currently always resolves
  // to [], but the effect is already written the way it would need to
  // be once loadPortfolio() does a real fetch.
  useEffect(() => {
    let cancelled = false;
    loadPortfolio().then((entries) => {
      if (!cancelled) {
        setHoldings(entries);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleAddEntry = useCallback(
    (e) => {
      e.preventDefault();
      const errors = validateForm(form);
      if (Object.keys(errors).length > 0) {
        setFormErrors(errors);
        return;
      }
      const entry = {
        id: nextId(),
        ticker: form.ticker,
        buyDate: form.buyDate,
        buyPrice: Number(form.buyPrice),
        quantity: Number(form.quantity),
        // Filled in once this page is wired to a backend that can price
        // the position live (see PriceChart / general_agent.py's live
        // data path for the pattern this will likely reuse).
        currentPrice: null,
        unrealizedPnlPct: null,
      };
      const next = [...holdings, entry];
      setHoldings(next);
      savePortfolio(next);
      setForm(EMPTY_FORM);
      setFormErrors({});
    },
    [form, holdings]
  );

  const handleRemove = useCallback(
    (id) => {
      const next = holdings.filter((h) => h.id !== id);
      setHoldings(next);
      savePortfolio(next);
    },
    [holdings]
  );

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
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
          padding: 1.25rem;
          max-width: 72rem;
          margin: 0 auto;
        }
        @media (min-width: 1024px) {
          .rs-layout { padding: 1.5rem 2rem 2rem; }
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
        .rs-header-top { padding: 1.25rem 1.5rem 1.25rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }

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

        /* ---------------- Panels ---------------- */
        .rs-panel { background: var(--card); border: 1px solid var(--line); }
        .rs-panel-title { color: var(--blue-700); border-bottom: 2px solid var(--blue-100); font-size: 11px; font-weight: 700; }

        .rs-empty-title { font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 15px; color: var(--ink); }
        .rs-empty-sub { font-size: 13px; color: var(--muted); }

        .rs-error { border: 1px solid rgba(192,54,45,0.3); background: rgba(192,54,45,0.06); border-radius: 12px; padding: 0.75rem 1rem; font-size: 13.5px; color: #8a2b21; }

        .rs-input { border: 1px solid var(--line); border-radius: 10px; font-size: 13.5px; background: var(--card); }
        .rs-input:focus { outline: none; border-color: var(--blue-500); box-shadow: 0 0 0 3px rgba(47,140,234,0.15); }
        .rs-send { background: linear-gradient(120deg, var(--blue-700), var(--blue-500)); color: #fff; border-radius: 999px; font-size: 13px; }
        .rs-send:hover:not(:disabled) { filter: brightness(1.06); }
        .rs-send:disabled { opacity: 0.4; }

        /* ---------------- Additive: form fields + select (new) ---------------- */
        .rs-field { display: flex; flex-direction: column; gap: 0.35rem; }
        .rs-field-label { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
        .rs-select { border: 1px solid var(--line); border-radius: 10px; font-size: 13.5px; background: var(--card); color: var(--ink); appearance: none; }
        .rs-select:focus { outline: none; border-color: var(--blue-500); box-shadow: 0 0 0 3px rgba(47,140,234,0.15); }
        .rs-field-error { font-size: 11.5px; color: var(--red-text); }

        /* ---------------- Additive: holdings table (new) ---------------- */
        .rs-table-wrap { overflow-x: auto; }
        .rs-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px; }
        .rs-table thead th {
          text-align: left; color: var(--blue-700); font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em;
          text-transform: uppercase; padding: 0.7rem 0.9rem; background: var(--panel); border-bottom: 2px solid var(--blue-100);
        }
        .rs-table tbody td { padding: 0.75rem 0.9rem; border-bottom: 1px solid var(--line); color: var(--ink); vertical-align: middle; }
        .rs-table tbody tr:last-child td { border-bottom: none; }
        .rs-table tbody tr:hover { background: var(--panel); }
        .rs-table-ticker { color: var(--blue-700); font-weight: 700; font-size: 12.5px; }
        .rs-table-placeholder { color: var(--muted); }
        .rs-remove-btn { color: var(--muted); background: transparent; border: none; cursor: pointer; padding: 0.3rem; border-radius: 8px; transition: color 0.15s, background 0.15s; }
        .rs-remove-btn:hover { color: var(--red-text); background: var(--red-bg); }

      `}</style>

      {/* Header */}
      <div className="rs-header-wrap">
        <header className="rs-header">
          <div className="rs-header-top">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="rs-ticker-wrap">
                <span className="rs-ticker-halo" aria-hidden="true" />
                <span className="rs-ticker-word">My Portfolio</span>
              </span>
              <span className="rs-company-name">Track your positions across the 5 curated stocks</span>
            </div>
            <span className="rs-ticker-tag uppercase tracking-wider rounded-full px-2.5 py-1">
              {holdings.length} {holdings.length === 1 ? "holding" : "holdings"}
            </span>
          </div>
        </header>
      </div>

      {/* Body */}
      <div className="rs-layout">
        {/* Add-trade form */}
        <section className="rs-panel rounded-2xl p-5">
          <h2 className="rs-panel-title uppercase tracking-widest mb-4 pb-2">Log a Trade</h2>
          <form onSubmit={handleAddEntry} noValidate>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5 items-start">
              <div className="rs-field">
                <FieldLabel>Ticker</FieldLabel>
                <select
                  className="rs-select px-3 py-2"
                  value={form.ticker}
                  onChange={(e) => updateField("ticker", e.target.value)}
                >
                  {CURATED_STOCKS.map((s) => (
                    <option key={s.ticker} value={s.ticker}>
                      {s.ticker} — {s.name}
                    </option>
                  ))}
                </select>
                {formErrors.ticker && <span className="rs-field-error">{formErrors.ticker}</span>}
              </div>

              <div className="rs-field">
                <FieldLabel>Buy Date</FieldLabel>
                <input
                  type="date"
                  className="rs-input px-3 py-2"
                  value={form.buyDate}
                  max={new Date().toISOString().slice(0, 10)}
                  onChange={(e) => updateField("buyDate", e.target.value)}
                />
                {formErrors.buyDate && <span className="rs-field-error">{formErrors.buyDate}</span>}
              </div>

              <div className="rs-field">
                <FieldLabel>Buy Price (₹)</FieldLabel>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 4128.40"
                  className="rs-input rs-mono px-3 py-2"
                  value={form.buyPrice}
                  onChange={(e) => updateField("buyPrice", e.target.value)}
                />
                {formErrors.buyPrice && <span className="rs-field-error">{formErrors.buyPrice}</span>}
              </div>

              <div className="rs-field">
                <FieldLabel>Quantity</FieldLabel>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="1"
                  placeholder="e.g. 10"
                  className="rs-input rs-mono px-3 py-2"
                  value={form.quantity}
                  onChange={(e) => updateField("quantity", e.target.value)}
                />
                {formErrors.quantity && <span className="rs-field-error">{formErrors.quantity}</span>}
              </div>

              <div className="rs-field justify-end h-full">
                <FieldLabel>&nbsp;</FieldLabel>
                <button type="submit" className="rs-send flex items-center justify-center gap-1.5 px-4 py-2 font-medium">
                  <Plus size={14} />
                  Add Trade
                </button>
              </div>
            </div>
          </form>
        </section>

        {/* Holdings table */}
        <section className="rs-panel rounded-2xl p-5">
          <h2 className="rs-panel-title uppercase tracking-widest mb-4 pb-2">Holdings</h2>

          {loading ? (
            <p className="rs-empty-sub px-1">Loading your portfolio…</p>
          ) : holdings.length === 0 ? (
            <EmptyHoldings />
          ) : (
            <div className="rs-table-wrap">
              <table className="rs-table">
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Buy Date</th>
                    <th>Buy Price</th>
                    <th>Quantity</th>
                    <th>Current Price</th>
                    <th>Unrealized P&amp;L %</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {holdings.map((h) => (
                    <tr key={h.id}>
                      <td className="rs-mono rs-table-ticker">{h.ticker}</td>
                      <td className="rs-mono">{formatDate(h.buyDate)}</td>
                      <td className="rs-mono">{formatRupee(h.buyPrice)}</td>
                      <td className="rs-mono">{h.quantity}</td>
                      {/* Filled in once this page is wired to a backend
                          that can price the position live -- see the
                          currentPrice/unrealizedPnlPct fields on the
                          PortfolioEntry shape above. */}
                      <td className="rs-mono rs-table-placeholder">
                        {h.currentPrice == null ? "—" : formatRupee(h.currentPrice)}
                      </td>
                      <td className="rs-mono rs-table-placeholder">
                        {h.unrealizedPnlPct == null ? "—" : `${h.unrealizedPnlPct.toFixed(2)}%`}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="rs-remove-btn"
                          onClick={() => handleRemove(h.id)}
                          aria-label={`Remove ${h.ticker} trade logged on ${h.buyDate}`}
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
