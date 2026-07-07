import StockResearchAssistant from "./components/StockResearchAssistant.jsx"; 
//frontend/src/components/StockResearchAssistant.jsx

// StockResearchAssistant covers all 5 stocks itself (an internal tab
// switcher swaps the active ticker, fundamentals, and chat context) — no
// prop needed here. If you later want per-stock URLs (e.g. /stocks/:ticker
// via react-router), that's a separate enhancement: read `ticker` from
// useParams() and pass it down as an initial-ticker prop, since right now
// the component always boots into "TCS" on mount.
export default function App() {
  return <StockResearchAssistant />;
}
