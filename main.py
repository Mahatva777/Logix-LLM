"""
main.py — FastAPI app exposing POST /chat, streaming answers over SSE, and
(in production) serving the built React frontend from the same origin.

Design note: guardrails.answer_query() has to see the FULL model output
before it can validate citations, drop an ungrounded Considerations
section, catch recommendation-leakage, and inject the disclaimer. So this
endpoint does NOT forward raw token-by-token output from Gemini -- it runs
the whole guardrailed pipeline first (off the event loop, via
asyncio.to_thread, since it's a blocking call), then streams the resulting,
already-validated markdown to the client in word-sized chunks so the UI
still gets a live-typing feel.

Frontend integration (see accompanying frontend/ project):
  - Dev: the React app runs on Vite (localhost:5173) and this app runs on
    uvicorn (localhost:8000). Two ways to bridge them, pick one:
      (a) Vite's dev proxy (frontend/vite.config.js) forwards /chat to
          :8000 -- the frontend's fetch("/chat") never needs a full URL
          and no CORS setup is needed on this side either. Preferred.
      (b) If you skip the proxy and hit http://127.0.0.1:8000/chat
          directly from the Vite origin, CORS is required -- the
          CORSMiddleware below covers that case too.
  - Prod: `npm run build` in frontend/ produces frontend/dist/. The
    StaticFiles mount at the bottom serves those files (and falls back to
    index.html for client-side routes) from this same FastAPI app, so
    /chat becomes same-origin and CORS is moot. Comment that mount out if
    you'd rather deploy the frontend separately (e.g. Vercel/Netlify) and
    keep this as a pure API -- in that case keep the CORS middleware and
    add your deployed frontend's origin to ALLOWED_ORIGINS.
"""

import asyncio
import json
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from guardrails import answer_query
from general_agent import answer_general_query
from portfolio_engine import answer_portfolio_query
from thesys_chat import router as thesys_router
from live_ingest import ingest_ticker_live, ticker_in_collection
from market_tools import fetch_quote


app = FastAPI()

# ---------------------------------------------------------------------------
# CORS -- only strictly needed if the frontend is NOT proxied (option a
# above) and NOT served from this same app (the StaticFiles mount below).
# Harmless to leave enabled either way.
# ---------------------------------------------------------------------------
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Seconds to wait between streamed word-chunks. 0 disables pacing (fastest
# possible delivery); a small value (e.g. 0.02) gives a visible typing
# effect for the demo. Tune freely.
STREAM_DELAY_SECONDS = 0.02

_TOKEN_RE = re.compile(r"\S+\s*")  # word plus any trailing whitespace


class ChatRequest(BaseModel):
    query: str
    ticker: str | None = None
    portfolio: list = []


class GeneralChatRequest(BaseModel):
    query: str


class PortfolioPosition(BaseModel):
    ticker: str
    buy_date: str | None = None
    buy_price: float
    quantity: float


class PortfolioChatRequest(BaseModel):
    query: str
    ticker: str | None = None
    portfolio: list[PortfolioPosition] = []


class IngestRequest(BaseModel):
    ticker: str


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _tokenize(text: str) -> list:
    return _TOKEN_RE.findall(text)


async def _stream_result(result: dict, include_chart: bool = False):
    """
    Shared tail end of both /chat and /chat/general: takes an already-
    computed {"answer", "sources", ...} dict and streams it as the same
    token/sources SSE event shape either route was already producing.

    `include_chart` is opt-in (only /chat/general passes True) because
    only answer_general_query()'s result dict has a "chart_data" key --
    guardrails.answer_query()'s does not, so checking for the key alone
    would be an implicit, easy-to-misread way to decide this per-route.
    """
    for token in _tokenize(result["answer"]):
        yield _sse("token", {"token": token})
        if STREAM_DELAY_SECONDS:
            await asyncio.sleep(STREAM_DELAY_SECONDS)

    # Sent once, after the full (already-guardrailed) answer has streamed.
    yield _sse("sources", {"sources": result["sources"]})

    # Sent last, and only if there's actually a chart to show -- omitted
    # entirely (not sent as null) so the frontend can treat "did I get a
    # chart_data event at all" as the signal, rather than unpacking a
    # payload that might be {"chart_data": null}.
    if include_chart:
        chart_data = result.get("chart_data")
        if chart_data:
            yield _sse("chart_data", {"chart_data": chart_data})


async def _stream_chat(query: str, ticker: str | None, portfolio: list = None):
    try:
        # answer_query() is a blocking call (Chroma + Gemini network I/O);
        # run it off the event loop so other requests aren't stalled.
        result = await asyncio.to_thread(answer_query, query, ticker, portfolio)
    except Exception as e:
        yield _sse("error", {"detail": str(e)})
        return

    async for event in _stream_result(result):
        yield event


async def _stream_chat_general(query: str):
    try:
        # Same blocking-call-off-the-event-loop treatment as _stream_chat
        # above -- answer_general_query() does its own network I/O
        # (Gemini + yfinance tool calls).
        result = await asyncio.to_thread(answer_general_query, query)
    except Exception as e:
        yield _sse("error", {"detail": str(e)})
        return

    async for event in _stream_result(result, include_chart=True):
        yield event


@app.post("/chat")
async def chat(req: ChatRequest):
    return StreamingResponse(
        _stream_chat(req.query, req.ticker, req.portfolio),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/chat/general")
async def chat_general(req: GeneralChatRequest):
    return StreamingResponse(
        _stream_chat_general(req.query),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


async def _stream_chat_portfolio(query: str, portfolio: list):
    """Stream portfolio-aware answers. Accepts any ticker — auto-ingests
    live yfinance data for tickers not yet in the Chroma collection."""
    try:
        # Convert Pydantic models → plain dicts (snake_case keys portfolio_engine expects)
        portfolio_dicts = [
            {
                "ticker":    p.ticker,
                "buy_date":  p.buy_date,
                "buy_price": p.buy_price,
                "quantity":  p.quantity,
            }
            for p in portfolio
        ]
        result = await asyncio.to_thread(answer_portfolio_query, query, portfolio_dicts)
    except Exception as e:
        yield _sse("error", {"detail": str(e)})
        return

    async for event in _stream_result(result):
        yield event

    # Also emit guardrail_flags so the frontend can log/display them if desired
    if result.get("guardrail_flags"):
        yield _sse("guardrail_flags", {"flags": result["guardrail_flags"]})


@app.post("/chat/portfolio")
async def chat_portfolio(req: PortfolioChatRequest):
    """Personalized portfolio Q&A. Works for any ticker — live yfinance data
    is auto-ingested into ChromaDB for tickers not already in the knowledge base."""
    return StreamingResponse(
        _stream_chat_portfolio(req.query, req.portfolio),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@app.post("/api/ingest/ticker")
async def ingest_ticker(req: IngestRequest):
    """Trigger a live yfinance ingest for any ticker into ChromaDB.
    Idempotent — safe to call even if the ticker is already in the DB (upsert).
    Returns {ticker, chunks_upserted, already_existed}."""
    ticker = req.ticker.strip().upper()
    already = ticker_in_collection(ticker)
    try:
        n = await asyncio.to_thread(ingest_ticker_live, ticker)
        return {"ticker": ticker, "chunks_upserted": n, "already_existed": already}
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))

_PRICE_CACHE = {"data": None, "ts": 0}
_PRICE_CACHE_TTL = 15  # seconds

CURATED_TICKERS = ["TCS", "HDFC", "ICICI", "INFY", "RELIANCE"]

@app.get("/api/prices")
async def get_prices():
    """Returns live INR quotes for the 5 curated stocks. Cached 15s."""
    import time
    now = time.time()
    if _PRICE_CACHE["data"] and (now - _PRICE_CACHE["ts"]) < _PRICE_CACHE_TTL:
        return _PRICE_CACHE["data"]

    quotes = {}
    for t in CURATED_TICKERS:
        try:
            q = await asyncio.to_thread(fetch_quote, t)
            quotes[t] = q
        except Exception:
            quotes[t] = {"ticker": t, "price": 0, "change": 0, "changePct": 0, "currency": "INR"}

    _PRICE_CACHE["data"] = quotes
    _PRICE_CACHE["ts"] = now
    return quotes


app.include_router(thesys_router)
# ---------------------------------------------------------------------------
# Serve the built frontend (production only).
#
# This MUST be registered after the /chat route above -- StaticFiles with
# html=True mounted at "/" acts as a catch-all, so anything declared after
# it would be unreachable.
#
# Before this works, build the frontend once:
#   cd frontend && npm install && npm run build
#
# If frontend/dist doesn't exist yet (e.g. fresh clone, dev-only workflow),
# this is skipped rather than crashing the app on startup.
# ---------------------------------------------------------------------------
_FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=_FRONTEND_DIST, html=True), name="frontend")
