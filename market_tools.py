"""
market_tools.py — Live market-data tools (yfinance), ported from
NeuralNine's "AI Stock Analysis Assistant" tool-calling pattern:
https://github.com/NeuralNine/youtube-tutorials/tree/main/AI%20Stock%20Analysis%20Assistant

Ported faithfully: the four @tool-decorated functions below have the same
names, descriptions, signatures, and underlying yfinance calls as the
reference repo, so they behave the same way when plugged into any
LangChain/LangGraph tool-calling agent -- not just general_agent.py's.

Each also has a plain (non-@tool) `fetch_*` counterpart that does the same
yfinance call but returns clean, JSON-serializable Python data instead of a
raw pandas DataFrame/Series. general_agent.py imports these `fetch_*`
functions directly rather than the @tool wrappers below, because it needs
the *structured* historical-price result (to build chart_data), not just
a string a model can read off a stringified DataFrame. The @tool wrappers
here call the same fetch_* functions, so there's exactly one place the
actual yfinance logic lives -- no duplicated data-fetching code between
"the tools a model calls" and "the data this backend needs to consume
programmatically."

ASSUMPTION: Indian NSE-listed tickers need a ".NS" suffix for yfinance to
resolve them correctly (e.g. "TCS" -> "TCS.NS", "RELIANCE" -> "RELIANCE.NS").
These functions do NOT auto-append it -- that judgment call is delegated
to the calling agent via its system prompt (see general_agent.py), the way
a tool-calling agent is meant to reason about tool inputs, rather than
hardcoding ticker-normalization logic in the tool layer itself.
"""

from langchain.tools import tool
import yfinance as yf


# ---------------------------------------------------------------------------
# Plain data-fetch helpers -- the single source of truth for the yfinance
# calls. JSON-serializable returns only (no raw DataFrames/Series/numpy
# scalars escaping this module).
# ---------------------------------------------------------------------------

def fetch_price(ticker: str) -> float:
    """Returns the most recent closing price for `ticker`."""
    stock = yf.Ticker(ticker)
    hist = stock.history()
    if hist.empty:
        raise ValueError(f"No price data found for ticker '{ticker}'.")
    return float(hist["Close"].iloc[-1])


def fetch_historical_prices(ticker: str, start_date: str, end_date: str) -> dict:
    """Returns {"ticker": "<TICKER>", "series": [{"date": "YYYY-MM-DD", "close": float}, ...]}."""
    stock = yf.Ticker(ticker)
    hist = stock.history(start=start_date, end=end_date)
    if hist.empty:
        return {"ticker": ticker.upper(), "series": []}
    series = [
        {"date": ts.strftime("%Y-%m-%d"), "close": round(float(close), 2)}
        for ts, close in hist["Close"].items()
    ]
    return {"ticker": ticker.upper(), "series": series}


def fetch_balance_sheet(ticker: str) -> dict:
    """Returns the most recent balance sheet as {line_item: {period_end_date: value}}."""
    stock = yf.Ticker(ticker)
    df = stock.balance_sheet
    if df is None or df.empty:
        return {}
    df = df.rename(columns=lambda c: c.strftime("%Y-%m-%d") if hasattr(c, "strftime") else str(c))
    return {str(idx): row.to_dict() for idx, row in df.iterrows()}


def fetch_news(ticker: str) -> list:
    """Returns yfinance's recent news list for `ticker` (empty list if none)."""
    stock = yf.Ticker(ticker)
    return stock.news or []


# ---------------------------------------------------------------------------
# LangChain @tool wrappers,
# Each delegates to the fetch_* helper above and stringifies the result for the model to read.
# ---------------------------------------------------------------------------

@tool("get_stock_price", description="A function that returns the current stock price based on a ticker symbol.")
def get_stock_price(ticker: str) -> str:
    return str(fetch_price(ticker))


@tool(
    "get_historical_stock_price",
    description="A function that returns the current stock price over time based on a ticker symbol and a start and end date.",
)
def get_historical_stock_price(ticker: str, start_date: str, end_date: str) -> str:
    return str(fetch_historical_prices(ticker, start_date, end_date))


@tool("get_balance_sheet", description="A function that returns the balance sheet based on a ticker symbol.")
def get_balance_sheet(ticker: str) -> str:
    return str(fetch_balance_sheet(ticker))


@tool("get_stock_news", description="A function that returns news based on a ticker symbol.")
def get_stock_news(ticker: str) -> str:
    return str(fetch_news(ticker))


# Ready-to-use list for any agent that just wants the four tools as-is,
# with no need for per-request chart-data capture (general_agent.py builds
# its own wrapped instances instead -- see _build_tools() there for why).
ALL_TOOLS = [get_stock_price, get_historical_stock_price, get_balance_sheet, get_stock_news]
