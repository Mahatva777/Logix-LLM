"""
thesys_chat.py — "Advance Generative UI" sandbox tab.

Backed by Thesys C1 (https://api.thesys.dev/v1/embed), an OpenAI-compatible
endpoint that returns a structured UI spec (charts/cards/tables) instead of
markdown, rendered on the frontend by @thesysai/genui-sdk's <C1Chat>.

Route: POST /api/chat/thesys

WIRE CONTRACT: this endpoint IS what <C1Chat apiUrl="/api/chat/thesys" />
calls directly. C1Chat's built-in fetch layer POSTs
{prompt: {role, content, id}, threadId, responseId} and expects back an
SSE stream of C1 DSL content deltas -- not a plain OpenAI JSON response.
Nothing here hand-rolls that SSE framing: the `thesys_genui_sdk` package's
`with_c1_response` FastAPI decorator plus the `write_content` /
`write_custom_markdown` context helpers produce the correct stream shape.
This is the officially documented Python/FastAPI pattern (see
https://docs.thesys.dev/guides/custom-markdown-responses, Python tab).

INSTALL (backend):
    pip install thesys-genui-sdk openai

WHERE THE API KEY GOES (you asked):
    Add one line to the SAME .env file rag_engine.py already loads from
    (backend/.env, next to your GEMINI_API_KEY line):

        THESYS_API_KEY=sk-th-...

    This module reads it with the identical .env-loading snippet
    rag_engine.py already uses, so no new config plumbing is needed and the
    key never has to touch the frontend -- the browser only ever talks to
    YOUR FastAPI server at /api/chat/thesys; your server is the only thing
    that holds the Thesys key and calls api.thesys.dev. Do not put this key
    in any .jsx file, any VITE_-prefixed env var, or anywhere else that
    ends up in the browser bundle -- it would be visible to anyone who
    opens devtools.

WIRING THIS INTO YOUR EXISTING APP (you likely have one main.py/app.py that
already defines `app = FastAPI()` for /chat and /chat/general):

    from thesys_chat import router as thesys_router
    app.include_router(thesys_router)

    Make sure your existing CORS middleware (whatever already allows your
    frontend origin to hit /chat and /chat/general) also covers this route --
    it will, automatically, if it's applied at the `app` level rather than
    per-router.

============================================================================
ISOLATION FROM THE MAIN APP'S GUARDRAILS -- BY DESIGN
============================================================================
This route does NOT import guardrails.py, does NOT use the Answer /
Considerations / Note contract, and runs none of the citation-existence,
relevance-filtering, or recommendation-leakage checks the other three tabs
run. That's intentional, per the brief: this tab is an explicitly-labeled
sandbox for open-ended exploration across any ticker, not the
compliance-critical surface.

The ONE thing carried over is a disclaimer instruction, because it's still
a financial app even in sandbox mode -- see SYSTEM_PROMPT below. This is a
prompted instruction, not a code-level guardrail: unlike guardrails.py's
deterministic disclaimer injection (which always fires regardless of what
the model does), here the model decides when a question "edges toward
investment advice" and writes the disclaimer itself. That's a materially
weaker guarantee than the rest of the app, on purpose, to keep this tab a
genuine low-friction sandbox -- flag this tradeoff explicitly if this ever
moves beyond a hackathon demo.
============================================================================
"""

import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter
from pydantic import BaseModel
from openai import OpenAI

from thesys_genui_sdk.fast_api import with_c1_response
import traceback
from thesys_genui_sdk.context import write_content, write_custom_markdown, get_assistant_message

from market_tools import fetch_price, fetch_historical_prices, fetch_balance_sheet, fetch_news

# ---------------------------------------------------------------------------
# .env loading -- identical convention to rag_engine.py, so THESYS_API_KEY
# lives in the same file as GEMINI_API_KEY with no new setup step.
# ---------------------------------------------------------------------------
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, val = line.split("=", 1)
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))

THESYS_API_KEY = os.environ.get("THESYS_API_KEY")
if not THESYS_API_KEY:
    raise RuntimeError(
        "THESYS_API_KEY is not set. Add THESYS_API_KEY=sk-th-... to backend/.env "
        "(the same .env file rag_engine.py reads GEMINI_API_KEY from)."
    )

C1_MODEL = "c1/anthropic/claude-sonnet-4/v-20251230"
MAX_TOOL_ROUNDS = 5  # hard cap so a runaway tool-call loop can't hang a request

client = OpenAI(api_key=THESYS_API_KEY, base_url="https://api.thesys.dev/v1/embed")

router = APIRouter()

# ---------------------------------------------------------------------------
# Tools -- thin OpenAI-style function schemas around market_tools.py's plain
# fetch_* helpers (NOT the @tool-decorated LangChain wrappers in that file --
# those are shaped for a LangChain tool-calling agent; C1's tool-calling is
# just the standard OpenAI function-calling schema). Same underlying
# yfinance calls either way -- fetch_* is still the single source of truth.
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_stock_price",
            "description": "Current stock price for a ticker symbol. For Indian NSE-listed "
                            "stocks, use the '.NS' suffix (e.g. 'TCS.NS', 'RELIANCE.NS').",
            "parameters": {
                "type": "object",
                "properties": {"ticker": {"type": "string"}},
                "required": ["ticker"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_historical_stock_price",
            "description": "Historical daily closing prices for a ticker between two dates.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ticker": {"type": "string"},
                    "start_date": {"type": "string", "description": "YYYY-MM-DD"},
                    "end_date": {"type": "string", "description": "YYYY-MM-DD"},
                },
                "required": ["ticker", "start_date", "end_date"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_balance_sheet",
            "description": "Most recent balance sheet line items for a ticker.",
            "parameters": {
                "type": "object",
                "properties": {"ticker": {"type": "string"}},
                "required": ["ticker"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_stock_news",
            "description": "Recent news headlines for a ticker.",
            "parameters": {
                "type": "object",
                "properties": {"ticker": {"type": "string"}},
                "required": ["ticker"],
                "additionalProperties": False,
            },
        },
    },
]

TOOL_IMPLS: Dict[str, Callable[..., Any]] = {
    "get_stock_price": lambda ticker: fetch_price(ticker),
    "get_historical_stock_price": lambda ticker, start_date, end_date: fetch_historical_prices(
        ticker, start_date, end_date
    ),
    "get_balance_sheet": lambda ticker: fetch_balance_sheet(ticker),
    "get_stock_news": lambda ticker: fetch_news(ticker),
}


def _run_tool(name: str, args: dict) -> str:
    """Never lets a bad ticker / yfinance hiccup blow up the request -- the
    model sees a small JSON error object instead and can react in-band
    (e.g. tell the user the ticker looks wrong), rather than the whole
    turn failing."""
    try:
        result = TOOL_IMPLS[name](**args)
    except Exception as e:
        result = {"error": str(e)}
    return json.dumps(result, default=str)


# ---------------------------------------------------------------------------
# System prompt (point 2 of the brief: disclaimer instruction)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are "Advance Generative UI," an open-ended stock exploration sandbox inside MoneyLogix. Unlike the rest of the app, you are not restricted to 5 curated stocks -- you can answer questions about any publicly traded ticker using the tools available to you (live price, historical price, balance sheet, news).

Use charts, cards, and tables where they make the answer clearer than plain text -- decide the best visual representation for the data yourself.

Call a tool whenever the answer depends on a real number, date, or event (price, financials, news). Never guess or estimate a figure you could instead look up.

Disclaimer rule (always follow this, this is still a financial app even in sandbox mode): if the user's question edges toward investment advice -- asking whether to buy/sell/hold, what's a "good" stock, price targets, portfolio allocation, or similar -- include a brief, factual disclaimer noting that this is general information, not investment advice, and that a qualified financial advisor should be consulted before making investment decisions. Keep it to one or two sentences near the end of your response, and don't let it interrupt the main content. For purely factual questions (e.g. "what's TCS's current price"), no disclaimer is needed.

This is a sandbox for open-ended exploration -- you don't need to follow any fixed Answer/Considerations/Note structure."""


# --- in-memory per-thread history -----------------------------------------
# Dev/demo store only, same pattern Thesys's own examples use. Swap for a
# real store (DB, Redis, etc.) before this goes beyond a hackathon demo --
# an in-process dict loses all history on every server restart and won't
# work at all once you run more than one backend instance.
_threads: Dict[str, List[Dict[str, Any]]] = {}


def _get_thread(thread_id: str) -> List[Dict[str, Any]]:
    if thread_id not in _threads:
        _threads[thread_id] = [{"role": "system", "content": SYSTEM_PROMPT}]
    return _threads[thread_id]


# ---------------------------------------------------------------------------
# Request contract (matches what C1Chat's apiUrl POSTs)
# ---------------------------------------------------------------------------

class PromptMessage(BaseModel):
    role: str
    content: str
    id: Optional[str] = None


class ThesysChatRequest(BaseModel):
    prompt: PromptMessage
    threadId: str
    responseId: str


@router.post("/api/chat/thesys")
@with_c1_response()
async def chat_thesys(request: ThesysChatRequest):
    messages = _get_thread(request.threadId)
    messages.append({"role": request.prompt.role, "content": request.prompt.content})

    try:
        await _run_and_stream(messages)
    except Exception:
        traceback.print_exc()
        await write_custom_markdown(
            "Something went wrong generating this response. Try rephrasing the question, or ask again."
        )


async def _run_and_stream(messages: List[Dict[str, Any]]) -> None:
    # Tool-resolution phase: non-streaming, since we need to inspect
    # tool_calls before knowing whether another round-trip is needed.
    # (Python's openai SDK doesn't have the JS SDK's `runTools` helper, so
    # this is the standard manual tool-call loop -- see
    # https://docs.thesys.dev/guides/integrate-data/tool-calling, Python tab.)
    completion = client.chat.completions.create(model=C1_MODEL, messages=messages, tools=TOOLS)

    for _ in range(MAX_TOOL_ROUNDS):
        message = completion.choices[0].message
        tool_calls = message.tool_calls or []
        if not tool_calls:
            break

        messages.append({
            "role": "assistant",
            "content": message.content or "",
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in tool_calls
            ],
        })
        for tc in tool_calls:
            args = json.loads(tc.function.arguments or "{}")
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": _run_tool(tc.function.name, args),
            })

        completion = client.chat.completions.create(model=C1_MODEL, messages=messages, tools=TOOLS)

    # Final phase: stream the UI-generating response for <C1Chat> to render.
    stream = client.chat.completions.create(model=C1_MODEL, messages=messages, stream=True)
    for chunk in stream:
        delta = chunk.choices[0].delta.content
        if delta:
            await write_content(delta)

    messages.append({"role": "assistant", "content": get_assistant_message()})
