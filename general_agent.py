"""
general_agent.py — "General Research" mode: a tool-calling agent that can
answer questions about ANY ticker (not just the 5 portfolio stocks) using
live yfinance data, while still emitting the same Answer/Considerations/
Note markdown contract the frontend already parses.

Public entry point:
    answer_general_query(query: str) -> dict
        Returns {"answer": <markdown str>,
                 "sources": [{"file": ..., "snippet": ...}],
                 "chart_data": {"ticker": str, "series": [{"date", "close"}]} | None}

This deliberately mirrors rag_engine.answer_query()'s return shape (plus
chart_data) so main.py can add one new route without touching how the
frontend parses "answer"/"sources".

Trade-offs vs. the portfolio rag_engine.py + guardrails.py path -- worth
being explicit about these in a discussion round:
  - No citation to a specific filename/section, because there isn't one:
    everything is grounded as "(Source: Yahoo Finance — live data,
    fetched <date>)" instead. See ASSUMPTION #2 below.
  - No MAX_RELEVANT_DISTANCE-style relevance filtering (there's no vector
    search here to filter) and no guardrails.py post-generation citation/
    Considerations-grounding checks -- those checks are specifically
    about validating that generated text is backed by *retrieved chunks*,
    which doesn't apply to a live tool-call result. What IS reused from
    guardrails.py is the section-parsing/rebuilding contract itself
    (split_sections / rebuild_markdown), so both paths produce markdown
    the same frontend code can parse.
  - No recommendation-leakage regex backstop (guardrails.py's
    has_recommendation_leakage) -- the system prompt below carries the
    same "never recommend buy/sell/hold" rule as rag_engine.py's, but
    there's no deterministic backstop replacing a leaked recommendation
    here. Flagged as a gap to close before this mode ships for real,
    not silently omitted.
"""

import os
import re
from datetime import datetime
from pathlib import Path

# Same .env loading rag_engine.py does, so GEMINI_API_KEY is available
# here too without depending on import order between the two modules.
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _key, _val = _line.split("=", 1)
            os.environ[_key.strip()] = _val.strip().strip('"').strip("'")

from langchain.agents import create_agent
from langchain.messages import HumanMessage
from langchain.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI

from market_tools import fetch_price, fetch_historical_prices, fetch_balance_sheet, fetch_news
from guardrails import split_sections, rebuild_markdown

# ASSUMPTION #1: same Gemini model rag_engine.py uses for generation, for
# consistent behavior/latency/cost between the curated and general paths.
GENERATION_MODEL = "gemini-2.5-flash"

# ASSUMPTION #2: citation format for live data, since there's no filename/
# section to cite. The frontend's citation regex is
#   /\(Source:\s*(.+?)\s+[—-]\s+(.+?)\)/
# which just needs *some* "(Source: X — Y)" shape -- "Yahoo Finance" fills
# the filename slot, "live data, fetched <date>" fills the section slot.
CITATION_TAG_RE = re.compile(r"\(Source:\s*Yahoo Finance\s+[—-]\s+live data")

SYSTEM_PROMPT = """You are the General Research mode of MoneyLogix's AI Research Assistant. Unlike the curated assistant (which only knows 5 pre-vetted Indian stocks from filed documents), you can look up LIVE data for any publicly traded stock using your tools.

Tools available:
- get_stock_price(ticker): current/most recent closing price
- get_historical_stock_price(ticker, start_date, end_date): daily closing price series between two dates (both "YYYY-MM-DD")
- get_balance_sheet(ticker): most recent balance sheet line items
- get_stock_news(ticker): recent news headlines

Ticker format: Indian NSE-listed stocks need a ".NS" suffix for these tools to resolve correctly (e.g. RELIANCE.NS, TCS.NS, HDFCBANK.NS, ICICIBANK.NS, INFY.NS). US and other exchange-listed stocks use their plain ticker (e.g. AAPL, MSFT). If a lookup fails or returns nothing, try again with a corrected ticker/suffix once before telling the user it isn't available.

Hard rules:
1. Only use information returned by your tools for this query -- never state a price, figure, or news fact from your own training data, since it will be stale. If a tool call fails or returns nothing useful, say so plainly rather than guessing.
2. Every factual claim drawn from a tool result must carry an inline citation in exactly this form: (Source: Yahoo Finance — live data, fetched {today}). Do not cite a filename or section -- there isn't one for live data.
3. You are not a financial advisor. Never issue buy/sell/hold recommendations, price targets, or portfolio allocation advice, even if asked directly -- redirect to what the live data does say instead.

Response format:
Structure your entire response using exactly these Markdown section headers, in this order, with no other headers, preambles, or closing remarks:

**Answer**
The direct response to the question, grounded in tool results, with inline citations after every factual claim.

**Considerations**
Include this section ONLY if the question involves risk, time horizon, liquidity, or a recommendation-adjacent framing (comparison, timing, safety, outlook). Draw these notes only from what the tool data actually shows (e.g. volatility visible in a historical series, a risk mentioned in a news headline) -- never introduce a risk factor that isn't backed by an actual tool result. Omit this entire section (header included) for pure factual lookups.

**Note**
Include this section ONLY if the question edges toward investment advice (buy/sell/invest, "is this a good stock", timing a purchase). When included, it must contain exactly this line and nothing else:
This is for informational purposes only and is not investment advice. Please consult a SEBI-registered investment advisor before making investment decisions.
Omit this entire section (header included) otherwise."""

USER_PROMPT_TEMPLATE = (
    "Question: {query}\n\n"
    "Today's date is {today} -- use it for \"current price\" style questions and "
    "for the (Source: Yahoo Finance — live data, fetched {today}) citation. "
    "Answer strictly following the system instructions and response format above."
)


def _today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _build_tools(chart_capture: dict):
    """
    Builds a FRESH set of tool instances for this single call, rather than
    reusing market_tools.ALL_TOOLS module-level objects. Two reasons:

    1. get_historical_stock_price needs to stash its structured result
       into `chart_capture` as a side effect, in addition to returning a
       string for the model. A per-call closure is the simplest way to do
       that without a module-level global -- which matters because
       main.py runs answer_general_query() via asyncio.to_thread (same
       pattern as guardrails.answer_query()), so concurrent requests are
       genuinely possible and a shared global would let one request's
       chart data leak into another's response.
    2. Wrapping each tool in a try/except here (rather than in
       market_tools.py's exported tools) means a single failed yfinance
       call surfaces to the agent as a normal tool-error message it can
       react to (e.g. retry with a ".NS" suffix), instead of raising and
       aborting the whole agent run.
    """

    @tool("get_stock_price", description="Returns the current (most recent close) stock price for a ticker symbol.")
    def get_stock_price(ticker: str) -> str:
        try:
            return f"{fetch_price(ticker):.2f}"
        except Exception as e:
            return f"Error fetching price for '{ticker}': {e}"

    @tool(
        "get_historical_stock_price",
        description="Returns historical daily closing prices for a ticker between start_date and end_date (both 'YYYY-MM-DD').",
    )
    def get_historical_stock_price(ticker: str, start_date: str, end_date: str) -> str:
        try:
            data = fetch_historical_prices(ticker, start_date, end_date)
        except Exception as e:
            return f"Error fetching historical prices for '{ticker}': {e}"
        if data["series"]:
            # Captured regardless of whether the agent ends up using this
            # in its final answer -- if the tool was called, we show the
            # chart. Last historical call wins if more than one is made.
            chart_capture["ticker"] = data["ticker"]
            chart_capture["series"] = data["series"]
            return str(data["series"])
        return f"No historical price data found for '{ticker}' between {start_date} and {end_date}."

    @tool("get_balance_sheet", description="Returns the most recent balance sheet line items for a ticker symbol.")
    def get_balance_sheet(ticker: str) -> str:
        try:
            return str(fetch_balance_sheet(ticker))
        except Exception as e:
            return f"Error fetching balance sheet for '{ticker}': {e}"

    @tool("get_stock_news", description="Returns recent news headlines for a ticker symbol.")
    def get_stock_news(ticker: str) -> str:
        try:
            return str(fetch_news(ticker))
        except Exception as e:
            return f"Error fetching news for '{ticker}': {e}"

    return [get_stock_price, get_historical_stock_price, get_balance_sheet, get_stock_news]


_model = None


def _get_model():
    global _model
    if _model is None:
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable is not set.")
        # langchain-google-genai looks for GOOGLE_API_KEY specifically;
        # mirror rag_engine.py's either-name convenience explicitly.
        os.environ.setdefault("GOOGLE_API_KEY", api_key)
        _model = ChatGoogleGenerativeAI(model=GENERATION_MODEL, temperature=0.2)
    return _model


def answer_general_query(query: str) -> dict:
    """
    Answers a natural-language question about ANY stock using live
    yfinance data via tool-calling, rather than the curated 5-stock RAG
    corpus. See module docstring for the full return shape and the
    trade-offs vs. rag_engine.answer_query() + guardrails.answer_query().

    No conversation memory: each call is independent (no checkpointer/
    thread_id), matching the stateless, single-question contract of the
    existing answer_query() functions.
    """
    today = _today_str()
    chart_capture: dict = {}
    tools = _build_tools(chart_capture)

    try:
        model = _get_model()
        agent = create_agent(model=model, tools=tools, system_prompt=SYSTEM_PROMPT)
        result = agent.invoke(
            {"messages": [HumanMessage(USER_PROMPT_TEMPLATE.format(query=query, today=today))]}
        )
    except Exception as e:
        return {
            "answer": f"**Answer**\nI wasn't able to reach live market data right now ({e}).",
            "sources": [],
            "chart_data": None,
        }

    final_message = result["messages"][-1]
    raw_answer = final_message.content if isinstance(final_message.content, str) else str(final_message.content)

    # Reuse guardrails.py's own section parser/rebuilder, so both the
    # curated and general paths produce markdown via the exact same
    # contract -- one place that defines what "**Answer**" etc. means.
    sections = split_sections(raw_answer)
    answer_markdown = rebuild_markdown(sections)

    sources = []
    if CITATION_TAG_RE.search(answer_markdown):
        sources = [{"file": "Yahoo Finance", "snippet": f"Live data fetched {today} via yfinance tool-calling."}]

    chart_data = None
    if chart_capture.get("series"):
        chart_data = {"ticker": chart_capture["ticker"], "series": chart_capture["series"]}

    return {"answer": answer_markdown, "sources": sources, "chart_data": chart_data}


if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print('Usage: python general_agent.py "<question>"')
        sys.exit(1)

    out = answer_general_query(sys.argv[1])
    print(out["answer"])
    print("\n--- sources ---")
    print(json.dumps(out["sources"], indent=2))
    print("\n--- chart_data ---")
    print(json.dumps(out["chart_data"], indent=2))
