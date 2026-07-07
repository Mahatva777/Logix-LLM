import StockResearchAssistant from "./components/StockResearchAssistant.jsx"; 
//frontend/src/components/StockResearchAssistant.jsx

// This is the TCS stock detail page. To turn it into a route per ticker
// later (e.g. with react-router), pass the ticker down as a prop instead
// of hardcoding it — StockResearchAssistant currently hardcodes "TCS" via
// its internal STOCK constant, so that's the one edit needed to genericize it.
export default function App() {
  return <StockResearchAssistant />;
}
