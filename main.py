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
from thesys_chat import router as thesys_router


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


class GeneralChatRequest(BaseModel):
    query: str


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


async def _stream_chat(query: str, ticker: str | None):
    try:
        # answer_query() is a blocking call (Chroma + Gemini network I/O);
        # run it off the event loop so other requests aren't stalled.
        result = await asyncio.to_thread(answer_query, query, ticker)
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
        _stream_chat(req.query, req.ticker),
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
