"""
portfolio_engine.py — Personalized "My Portfolio" answers for the AI Research
Assistant. Combines live yfinance prices, the existing curated Chroma store,
and (optionally) a historical-event match, then generates through the same
Answer / Considerations / Note contract as rag_engine.py / guardrails.py.

Public entry point:
    answer_portfolio_query(query: str, portfolio: list) -> dict
        portfolio: [{"ticker": "TCS", "buy_date": "YYYY-MM-DD",
                     "buy_price": float, "quantity": float}, ...]
        Returns {"answer": <markdown str>, "sources": [...], "guardrail_flags": [...]}

ASSUMPTION: portfolio entries use snake_case keys as specified in the task
(ticker, buy_date, buy_price, quantity) and buy_date is "YYYY-MM-DD". The
frontend (PortfolioPage.jsx) currently stores camelCase (buyDate, buyPrice) --
convert at the API boundary (e.g. in the FastAPI request model / a small
adapter) before calling this function. Not done here since that's a wiring
detail, not this function's job.

WHY THIS FILE IS SEPARATE FROM guardrails.py's answer_query, not a variant
of it: that function's entire contract assumes a single retrieval pass for
one implicit subject. Here the "subject" is a set of positions, the prompt
must carry numbers that did NOT come from Chroma at all (live price, P&L),
and the highest-risk failure mode is different in kind: guardrails.py mainly
guards against citing sources that don't exist. Here the model could
instead *restate the user's own money* wrong, or slide "you're up 12%"
into "so now's a good time to...". Both need a dedicated check (see
_validate_position_numbers and PORTFOLIO_LEAKAGE_RE below) -- reusing
guardrails.py's checks (they still run, unmodified) is necessary but not
sufficient for this surface.

============================================================================
WHERE PERSONALIZATION COULD TIP INTO ADVICE, AND HOW THIS FILE STOPS THAT
============================================================================
Restating "you bought at ₹X, it's now ₹Y, that's +Z%" is information -- it's
just arithmetic on facts the user already gave us. The line into advice gets
crossed in three specific places, and each has a specific guard here:

1. EVALUATIVE FRAMING OF THE USER'S OWN NUMBERS.
   "You're up 12%" is fine. "You're up 12%, which is a healthy gain worth
   locking in" is not -- the second half is a recommendation wearing the
   first half's factual costume. This is the single easiest place for a
   generation model to drift, because the *number* is grounded and true,
   so the check that catches ordinary hallucination (citation-existence)
   passes cleanly right up to the moment the model appends an opinion.
   Guard: PORTFOLIO_SYSTEM_PROMPT rule 4 explicitly forbids evaluative or
   action-oriented language attached to the user's P&L, gain/loss framing,
   or holding duration -- not just the word "buy/sell". PORTFOLIO_LEAKAGE_RE
   below extends guardrails.py's leakage patterns with the softer phrasings
   this framing tends to use (trim, book profit, average down, good entry
   point, add to your position) that plain buy/sell/hold regex misses.

2. NARRATIVE CAUSALITY BETWEEN A NOTABLE EVENT AND THE USER'S TIMING.
   Surfacing "TCS dropped 4% on 2025-11-14, and your Considerations
   mentions a Q2 miss noted around then" is a fact pattern. "...so this
   would've been a good time to average down" is advice, and it's a more
   dangerous version than (1) because it launders the recommendation
   through a real, correctly-cited historical event -- it reads as
   analysis, not opinion. Guard: the notable-events block handed to the
   model is pre-formatted as dated, past-tense facts only ("On <date>,
   <ticker> moved <pct>% during a window with retrieved coverage: <cite>");
   the system prompt instructs the model to describe the coincidence, never
   to characterize it as an opportunity, mistake, or signal, and forbids
   any statement about what the user should have done or should do now.

3. CONSIDERATIONS THAT USE THE USER'S ENTRY PRICE/HORIZON AS A PREMISE FOR
   A CONCLUSION, RATHER THAN AS CONTEXT.
   The task explicitly wants Considerations to reference the user's actual
   entry price and holding period -- that's the point of personalizing it.
   But "you've held for 8 months, which is short-term, so..." becomes advice
   the instant "so" resolves into a suggestion. Guard: same as (1)/(2) --
   the prompt requires Considerations to state the holding-period /
   entry-price fact and pair it only with what the *retrieved context*
   already says about risk/horizon (verbatim-grounded, same as the base
   app), never with the model's own synthesis of what that combination
   implies for action. Post-generation, sections["considerations"] is
   dropped (not just flagged) if it isn't grounded in a real citation --
   identical policy to guardrails.py, applied without exception here.

On top of those three, there's a fourth failure mode that's about accuracy,
not tone: the model could simply misstate the user's own P&L number (typo a
digit, round the wrong way, or "helpfully" recompute it slightly differently
than we did). That's not advice-creep, but on a portfolio screen a wrong
number is arguably worse -- it's a factual error about someone's money
presented with false authority. _validate_position_numbers() checks every
currency/percentage-looking token in the Answer/Considerations against a
whitelist of the numbers we actually computed, and if the model states a
number we can't verify, guardrails.py's-style safety net swaps the whole
Answer for a deterministic, code-generated summary rather than showing an
unverifiable number next to someone's real position.

The Note is not optional here and is never left to the model's judgement:
advice_seeking is hardcoded True for this endpoint (see answer_portfolio_query)
regardless of how the query is phrased, because a personalized position
readout is advice-adjacent by construction -- there's no "purely factual
lookup" framing of "how am I doing" the way there is for "what was TCS's
revenue last quarter".
============================================================================
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from rag_engine import _get_engine, reset_engine, TOP_K_PER_TICKER, tickers_in_collection
from guardrails import (
    filter_by_relevance,
    split_sections,
    extract_citations,
    rebuild_markdown,
    pick_disclaimer,
)
from market_tools import fetch_price, fetch_historical_prices
from live_ingest import ingest_ticker_live, ticker_in_collection

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DAY_MOVE_THRESHOLD_PCT = 3.0     # single-day move worth surfacing
WEEK_MOVE_THRESHOLD_PCT = 6.0    # 5-trading-day cumulative move worth surfacing
NEWS_DATE_MATCH_WINDOW_DAYS = 3  # a news chunk "coincides" with a move within +/- this many days
MAX_EVENTS_PER_TICKER = 3        # cap so one volatile stock doesn't dominate the prompt

# Tolerance for the number-grounding check. Percentages are compared in
# absolute percentage points (rounding/display drift); currency amounts are
# compared relatively, since ₹ figures vary in magnitude across tickers.
PCT_TOLERANCE_ABS = 0.15
CURRENCY_TOLERANCE_REL = 0.005   # 0.5%

_DATE_FORMATS = ["%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"]


def _parse_date(s) -> date | None:
    if not s:
        return None
    if isinstance(s, date):
        return s
    s = str(s).strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# Extends guardrails.py's _LEAKAGE_RE with the softer, position-framed
# phrasings that are specific to commenting on an existing holding rather
# than a cold buy/sell call. Kept as tight, multi-word patterns for the same
# false-positive reason as the base regex.
PORTFOLIO_LEAKAGE_RE = re.compile(
    r"\byou should (buy|sell|hold|trim|add|average down)\b"
    r"|\bi recommend (buying|selling|holding|trimming|adding)\b"
    r"|\bis a (good|great|strong|solid) (buy|sell|investment|entry point)\b"
    r"|\bgood (time|entry point) to (buy|sell|add|average down)\b"
    r"|\bconsider (trimming|adding to|exiting|averaging down on)\b"
    r"|\b(book|lock in|take) profit\b"
    r"|\badd (it|this|these|that|more) to your (position|portfolio|holding)\b"
    r"|\bworth (trimming|exiting|adding to)\b"
    r"|\b(would've|would have) been a good time\b",
    re.I,
)


# ---------------------------------------------------------------------------
# Step 1 -- live prices + P&L
# ---------------------------------------------------------------------------

def _compute_positions(portfolio: list) -> tuple[list, list]:
    """Returns (positions, flags). Each position dict carries every number
    the prompt/whitelist will need, pre-formatted, so nothing downstream
    ever recomputes or reformats them differently."""
    positions, flags = [], []
    today = date.today()

    for entry in portfolio:
        ticker = str(entry["ticker"]).upper()
        buy_price = float(entry["buy_price"])
        quantity = float(entry["quantity"])
        buy_date = _parse_date(entry.get("buy_date"))

        try:
            current_price = fetch_price(ticker)
        except Exception as e:
            flags.append({
                "stage": "position-pricing", "type": "error",
                "detail": f"Couldn't fetch a live price for {ticker}: {e}. "
                          f"Excluded from this answer's position data.",
            })
            continue

        invested_value = buy_price * quantity
        current_value = current_price * quantity
        pnl_abs = current_value - invested_value
        pnl_pct = (current_price - buy_price) / buy_price * 100 if buy_price else 0.0
        holding_days = (today - buy_date).days if buy_date else None

        positions.append({
            "ticker": ticker,
            "buy_date": buy_date,
            "buy_price": round(buy_price, 2),
            "quantity": quantity,
            "current_price": round(current_price, 2),
            "invested_value": round(invested_value, 2),
            "current_value": round(current_value, 2),
            "pnl_abs": round(pnl_abs, 2),
            "pnl_pct": round(pnl_pct, 2),
            "holding_days": holding_days,
        })

    return positions, flags


def _build_position_block(positions: list) -> str:
    if not positions:
        return "(No positions could be priced -- live price data unavailable.)"

    lines = []
    for p in positions:
        holding_desc = f"{p['holding_days']} day(s)" if p["holding_days"] is not None else "unknown holding period"
        lines.append(
            f"- {p['ticker']}: bought {p['quantity']} share(s) at ₹{p['buy_price']} on "
            f"{p['buy_date'] or 'an unknown date'} (holding period: {holding_desc}). "
            f"Current price ₹{p['current_price']}. "
            f"Invested value ₹{p['invested_value']}, current value ₹{p['current_value']}, "
            f"unrealized P&L ₹{p['pnl_abs']} ({p['pnl_pct']:+}%)."
        )

    if len(positions) > 1:
        total_invested = round(sum(p["invested_value"] for p in positions), 2)
        total_current = round(sum(p["current_value"] for p in positions), 2)
        total_pnl_pct = round((total_current - total_invested) / total_invested * 100, 2) if total_invested else 0.0
        lines.append(
            f"- PORTFOLIO TOTAL: invested ₹{total_invested}, current value ₹{total_current}, "
            f"overall unrealized P&L {total_pnl_pct:+}%."
        )

    return "\n".join(lines)


def _numeric_whitelist(positions: list) -> dict:
    """Every currency figure and every percentage figure that is legitimate
    to state, keyed by kind so tolerance can differ."""
    currency, percent = [], []
    for p in positions:
        currency.extend([p["buy_price"], p["current_price"], p["invested_value"],
                          p["current_value"], abs(p["pnl_abs"])])
        percent.append(p["pnl_pct"])
    if len(positions) > 1:
        total_invested = sum(p["invested_value"] for p in positions)
        total_current = sum(p["current_value"] for p in positions)
        currency.extend([round(total_invested, 2), round(total_current, 2),
                          round(abs(total_current - total_invested), 2)])
        if total_invested:
            percent.append(round((total_current - total_invested) / total_invested * 100, 2))
    return {"currency": currency, "percent": percent}


# ---------------------------------------------------------------------------
# Step 2 -- curated retrieval, per held ticker (unconditional -- unlike the
# base app's ticker-detection heuristic, every held ticker is "in scope" for
# a portfolio question regardless of whether the query names it).
# ---------------------------------------------------------------------------

def _retrieve_for_tickers(engine, query: str, tickers: list) -> list:
    seen_ids = set()
    chunks = []
    for t in tickers:
        res = engine._query_chroma(query, top_k=TOP_K_PER_TICKER, ticker=t)
        chunks.extend(engine._flatten(res, seen_ids))
    return chunks


# ---------------------------------------------------------------------------
# Step 3 -- optional historical event matching
# ---------------------------------------------------------------------------

PERFORMANCE_PATTERN = re.compile(
    r"\b(performance|since (i )?(bought|buying|purchas\w*)|how (has|have|is|are) (it|they|my \w+) (done|doing|performed|performing)|"
    r"price move|volatil|\bdrop(ped)?\b|\bdip(ped)?\b|\brall(y|ied)\b|\brise|\bfell\b|\bfall\b|"
    r"swing|holding period|what happened)\b",
    re.I,
)


def wants_performance_history(query: str) -> bool:
    return bool(PERFORMANCE_PATTERN.search(query))


def _price_moves(series: list) -> list:
    """series: [{"date": "YYYY-MM-DD", "close": float}, ...] sorted ascending.
    Returns [{"date": date, "pct": float, "window": "day"|"week"}, ...]."""
    moves = []
    parsed = [(_parse_date(pt["date"]), pt["close"]) for pt in series]
    parsed = [(d, c) for d, c in parsed if d is not None]

    for i in range(1, len(parsed)):
        d0, c0 = parsed[i - 1]
        d1, c1 = parsed[i]
        if c0:
            pct = (c1 - c0) / c0 * 100
            if abs(pct) >= DAY_MOVE_THRESHOLD_PCT:
                moves.append({"date": d1, "pct": round(pct, 2), "window": "day"})

    for i in range(5, len(parsed)):
        d0, c0 = parsed[i - 5]
        d1, c1 = parsed[i]
        if c0:
            pct = (c1 - c0) / c0 * 100
            if abs(pct) >= WEEK_MOVE_THRESHOLD_PCT:
                moves.append({"date": d1, "pct": round(pct, 2), "window": "week"})

    moves.sort(key=lambda m: -abs(m["pct"]))
    return moves


def _match_events_to_news(ticker: str, moves: list, chunks: list) -> list:
    """chunks: retrieved curated chunks (any ticker) -- filtered here to this
    ticker's chunks that have a parseable metadata date. Gracefully returns
    [] if there are no dated moves or no dated chunks -- this whole feature
    is best-effort, never an error."""
    dated_chunks = []
    for c in chunks:
        if str(c["metadata"].get("ticker", "")).upper() != ticker:
            continue
        d = _parse_date(c["metadata"].get("date"))
        if d:
            dated_chunks.append((d, c))

    if not dated_chunks:
        return []

    events = []
    for move in moves[:MAX_EVENTS_PER_TICKER]:
        best = min(dated_chunks, key=lambda dc: abs((dc[0] - move["date"]).days))
        if abs((best[0] - move["date"]).days) <= NEWS_DATE_MATCH_WINDOW_DAYS:
            meta = best[1]["metadata"]
            events.append({
                "ticker": ticker,
                "date": move["date"],
                "pct": move["pct"],
                "window": move["window"],
                "filename": meta.get("filename", "?"),
                "section": meta.get("section", "?"),
            })
    return events


def _build_events_block(events: list) -> str | None:
    if not events:
        return None
    lines = []
    for e in events:
        lines.append(
            f"- On {e['date']}, {e['ticker']} moved {e['pct']:+}% over the preceding "
            f"{e['window']}, coinciding (within {NEWS_DATE_MATCH_WINDOW_DAYS} days) with "
            f"coverage in {e['filename']} — {e['section']}. State this as a dated fact "
            f"only; do not characterize it as a missed opportunity, a mistake, or a signal "
            f"for future action."
        )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Step 4 -- prompt + generation
# ---------------------------------------------------------------------------

PORTFOLIO_SYSTEM_PROMPT = """You are the AI Research Assistant's "My Portfolio" mode on MoneyLogix, answering a logged-in user about their OWN logged holdings across any publicly traded stock.

You are given three kinds of input, and ONLY these:
(a) POSITION DATA -- pre-computed figures for the user's actual holdings (entry price, current price, P&L, holding period). These numbers are already correct. Copy them exactly as given. Do not perform your own arithmetic on them, do not round them differently, and do not restate a figure you were not given.
(b) RETRIEVED CONTEXT -- research chunks from the knowledge base (curated docs or live yfinance data), each labeled with its source file/section.
(c) NOTABLE EVENTS (optional) -- dated coincidences between a price move during the user's holding period and retrieved coverage, if any were found. Treat these strictly as dated facts.

Hard rules:
1. Every factual claim beyond the position data itself must be grounded in the retrieved context and carry an inline citation in the form (Source: <filename> — <section>). Never cite a source for a claim it doesn't support.
2. Never invent, estimate, or restate-with-a-different-value any number, date, or event not present in the position data, retrieved context, or notable events block.
3. If something isn't covered by what you were given, say so plainly rather than filling the gap.
4. You are not a financial advisor. Never recommend buying, selling, holding, adding to, trimming, exiting, or averaging into any position, and never characterize the user's gain/loss, holding period, or a notable event as a reason to take or avoid action -- not even hedged or conditional framing ("you might consider...", "this could be a good time to..."). If asked directly whether to buy/sell/hold/add/trim, decline and redirect to what the position data and retrieved context factually show instead.
5. You may and should reference the user's actual entry price, current price, P&L, and holding period in the Considerations section -- that personalization is expected. What is NOT allowed is turning that reference into a conclusion about what the user should do with it.

Response format -- exactly these headers, in this order, no others:

**Answer**
Direct answer to the question, grounded per the rules above, with inline citations on every claim drawn from retrieved context. Position-data figures need no citation (they're given, not retrieved) but must be stated exactly as given.

**Considerations**
Include this section whenever the question touches risk, performance, timing, or is about the position generally (which portfolio questions almost always are). It must explicitly reference the user's specific entry price and/or holding period, and must pair that with only what the retrieved context or notable-events block already states about risk/outlook/history -- never your own synthesis of what the combination implies for action.

**Note**
Always include this section for portfolio answers, with exactly this line and nothing else:
This is for informational purposes only and is not investment advice. Please consult a SEBI-registered investment advisor before making investment decisions."""

USER_PROMPT_TEMPLATE = """POSITION DATA (pre-computed -- copy exactly, do not recompute):
{position_block}

RETRIEVED CONTEXT ({num_chunks} chunk(s)):
{context_block}

NOTABLE EVENTS DURING HOLDING PERIOD:
{events_block}

Question: {query}

Answer strictly following the system instructions and response format above."""


def _generate(engine, query: str, position_block: str, context_block: str,
              events_block: str | None, num_chunks: int) -> str:
    from google.genai import types  # local import matches rag_engine.py's lazy usage style

    user_prompt = USER_PROMPT_TEMPLATE.format(
        position_block=position_block,
        num_chunks=num_chunks,
        context_block=context_block or "(none retrieved)",
        events_block=events_block or "(none found for this query/holding period)",
        query=query,
    )
    response = engine.client.models.generate_content(
        model="gemini-2.5-flash",
        contents=user_prompt,
        config=types.GenerateContentConfig(
            system_instruction=PORTFOLIO_SYSTEM_PROMPT,
            temperature=0.2,
        ),
    )
    return response.text


# ---------------------------------------------------------------------------
# Step 5 -- portfolio-specific guardrail: numeric grounding
# ---------------------------------------------------------------------------

_CURRENCY_TOKEN_RE = re.compile(r"₹\s?([\d,]+(?:\.\d+)?)")
_PERCENT_TOKEN_RE = re.compile(r"([+-]?\d+(?:\.\d+)?)\s?%")


def _matches_any(value: float, whitelist: list, rel_tol: float = None, abs_tol: float = None) -> bool:
    for w in whitelist:
        if abs_tol is not None and abs(value - w) <= abs_tol:
            return True
        if rel_tol is not None and w != 0 and abs(value - w) / abs(w) <= rel_tol:
            return True
    return False


def _validate_position_numbers(text: str, whitelist: dict) -> list:
    """Returns a list of (kind, value) tuples for any currency/percentage
    figure in `text` that doesn't match a real computed value. Empty list
    means everything checks out."""
    if not text:
        return []
    unverified = []

    for raw in _CURRENCY_TOKEN_RE.findall(text):
        value = float(raw.replace(",", ""))
        if not _matches_any(value, whitelist["currency"], rel_tol=CURRENCY_TOLERANCE_REL):
            unverified.append(("currency", value))

    for raw in _PERCENT_TOKEN_RE.findall(text):
        value = float(raw)
        if not _matches_any(value, whitelist["percent"], abs_tol=PCT_TOLERANCE_ABS):
            unverified.append(("percent", value))

    return unverified


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def answer_portfolio_query(query: str, portfolio: list) -> dict:
    """Personalized, guardrailed answer for the "My Portfolio" page.

    Args:
        query: user's natural-language question about their holdings.
        portfolio: [{"ticker", "buy_date", "buy_price", "quantity"}, ...],
                   scoped to the 5 curated tickers.

    Returns:
        {"answer": <markdown>, "sources": [...], "guardrail_flags": [...]}
    """
    flags = []

    if not portfolio:
        return {
            "answer": "**Answer**\nYou don't have any logged holdings yet, so I don't have "
                      "a position to answer about. Log a trade first, or ask me about a "
                      "stock in General Research mode.",
            "sources": [],
            "guardrail_flags": [],
        }

    # ---- [1] live prices + P&L (never fabricated -- computed in Python, not by the model) ----
    positions, price_flags = _compute_positions(portfolio)
    flags.extend(price_flags)

    if not positions:
        return {
            "answer": "**Answer**\nI wasn't able to fetch live prices for any of your "
                      "holdings right now, so I can't give you an up-to-date position "
                      "readout. Please try again shortly.",
            "sources": [],
            "guardrail_flags": flags,
        }

    tickers = [p["ticker"] for p in positions]
    position_block = _build_position_block(positions)
    whitelist = _numeric_whitelist(positions)

    # ---- [1b] auto-ingest any tickers not yet in Chroma -------------------------
    # For portfolio tickers outside the curated 5 (or any ticker with no DB data),
    # pull live yfinance data and upsert it so retrieval has something to work with.
    # This is best-effort: if it fails, we proceed with whatever is already in the DB.
    known_tickers = tickers_in_collection()
    for t in tickers:
        # Match both plain ("TCS") and suffixed ("TCS.NS") forms
        base = t.split(".")[0]
        if t not in known_tickers and base not in known_tickers:
            try:
                n = ingest_ticker_live(t)
                flags.append({"stage": "live-ingest", "type": "info",
                              "detail": f"Live-ingested {t} ({n} chunks) from Yahoo Finance."})
            except Exception as e:
                flags.append({"stage": "live-ingest", "type": "warn",
                              "detail": f"Live ingest for {t} failed: {e}. Proceeding with existing DB data."})

    # ---- [2] curated retrieval, per held ticker (same Chroma path as rag_engine) ----
    try:
        engine = _get_engine()
        raw_chunks = _retrieve_for_tickers(engine, query, tickers)
    except Exception as e:
        if "tenant" in str(e).lower() or "connect" in str(e).lower():
            reset_engine()
            engine = _get_engine()
            raw_chunks = _retrieve_for_tickers(engine, query, tickers)
            flags.append({"stage": "retrieval", "type": "info",
                          "detail": "Chroma connection reset and retried successfully."})
        else:
            return {
                "answer": f"**Answer**\nI wasn't able to search the knowledge base right now ({e}).",
                "sources": [],
                "guardrail_flags": flags + [{"stage": "retrieval", "type": "error", "detail": str(e)}],
            }

    chunks, n_dropped = filter_by_relevance(raw_chunks)
    if n_dropped:
        flags.append({"stage": "post-retrieval", "type": "info",
                      "detail": f"Dropped {n_dropped} chunk(s) below the relevance threshold."})
    context_block = engine._build_context_block(chunks) if chunks else ""

    # ---- [3] optional historical event matching (best-effort, never blocking) ----
    events_block = None
    if wants_performance_history(query):
        all_events = []
        for p in positions:
            if not p["buy_date"]:
                continue
            try:
                hist = fetch_historical_prices(
                    p["ticker"], p["buy_date"].isoformat(), date.today().isoformat()
                )
                moves = _price_moves(hist["series"])
                all_events.extend(_match_events_to_news(p["ticker"], moves, chunks))
            except Exception as e:
                flags.append({"stage": "event-matching", "type": "info",
                              "detail": f"Skipped historical event check for {p['ticker']}: {e}"})
        events_block = _build_events_block(all_events)
        if all_events:
            flags.append({"stage": "event-matching", "type": "info",
                          "detail": f"Surfaced {len(all_events)} notable event(s)."})

    # ---- [4] generation ----
    try:
        raw_answer = _generate(engine, query, position_block, context_block, events_block, len(chunks))
    except Exception as e:
        return {
            "answer": f"**Answer**\nI have your position data but generation failed ({e}). "
                      f"Here's what I have on file: {position_block}",
            "sources": engine._build_sources(chunks),
            "guardrail_flags": flags + [{"stage": "generation", "type": "error", "detail": str(e)}],
        }

    # ---- [5] post-generation guardrails ----
    sections = split_sections(raw_answer)
    allowed_filenames = {str(c["metadata"].get("filename", "")).strip().lower() for c in chunks}

    # 5a. citation-existence (same policy as guardrails.py) -- context claims only.
    answer_bad = [fn for fn, _ in extract_citations(sections["answer"]) if fn.lower() not in allowed_filenames]
    if answer_bad:
        flags.append({"stage": "post-generation", "type": "flag",
                      "detail": f"Answer cites source(s) not present in retrieved context: {sorted(set(answer_bad))}"})

    # 5b. Considerations grounding: same drop-if-ungrounded policy as guardrails.py.
    if sections["considerations"]:
        cits = extract_citations(sections["considerations"])
        bad = [fn for fn, _ in cits if fn.lower() not in allowed_filenames]
        if not cits or bad:
            reason = "contained no citations at all" if not cits else f"cited unknown source(s): {sorted(set(bad))}"
            flags.append({"stage": "post-generation", "type": "flag",
                          "detail": f"Considerations section dropped -- {reason}."})
            sections["considerations"] = None

    # 5c. leakage safety net -- extended pattern set, always checked (advice-adjacent by construction).
    leaked = bool(PORTFOLIO_LEAKAGE_RE.search(sections["answer"] or "")) or \
             bool(PORTFOLIO_LEAKAGE_RE.search(sections.get("considerations") or ""))
    if leaked:
        flags.append({"stage": "post-generation", "type": "flag",
                      "detail": "Recommendation-like language detected; replaced with a safe fallback."})
        sections["answer"] = (
            f"I can share your position details and the retrieved research, but I'm not able "
            f"to tell you whether to buy, sell, hold, add to, or trim this position.\n\n{position_block}"
        )
        sections["considerations"] = None

    # 5d. THE highest-risk check for this endpoint: every currency/percentage
    # figure in the output must match a number we actually computed. This
    # catches both restatement errors and numbers the model invented
    # (e.g. a target price, a rounded-differently P&L) that would otherwise
    # sail past every other check because they "look" grounded.
    unverified = _validate_position_numbers(sections["answer"] or "", whitelist) + \
                 _validate_position_numbers(sections.get("considerations") or "", whitelist)
    if unverified:
        flags.append({"stage": "post-generation", "type": "flag",
                      "detail": f"Unverifiable position figure(s) in output, replaced with a safe "
                                f"fallback: {unverified}"})
        sections["answer"] = (
            f"I want to make sure the numbers I show you about your own position are exactly "
            f"right, and the figures I generated didn't match what I actually computed, so "
            f"here's the verified version instead:\n\n{position_block}"
        )
        sections["considerations"] = None

    # 5e. Note is deterministic and mandatory for this endpoint, full stop --
    # advice_seeking is not inferred from the query text here, unlike the
    # base app, because a personalized position readout is advice-adjacent
    # by construction regardless of phrasing.
    sections["note"] = pick_disclaimer(query)

    return {
        "answer": rebuild_markdown(sections),
        "sources": engine._build_sources(chunks),
        "guardrail_flags": flags,
    }


if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print('Usage: python portfolio_engine.py "<question>" \'[{"ticker":"TCS","buy_date":"2025-01-15","buy_price":3800,"quantity":10}]\'')
        sys.exit(1)

    q = sys.argv[1]
    pf = json.loads(sys.argv[2]) if len(sys.argv) > 2 else []
    result = answer_portfolio_query(q, pf)
    print(result["answer"])
    print("\n--- sources ---")
    print(json.dumps(result["sources"], indent=2))
    print("\n--- guardrail_flags ---")
    print(json.dumps(result["guardrail_flags"], indent=2, default=str))
