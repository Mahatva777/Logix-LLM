"""
guardrails.py — Compliance + grounding guardrails around rag_engine.RagEngine.

Drop-in replacement for rag_engine.answer_query: same signature, same return
shape, plus one extra key ("guardrail_flags") for logging/observability.

    from guardrails import answer_query   # instead of: from rag_engine import answer_query

Pipeline placement (see the four numbered checks below, and the write-up
that goes with this file for the "why"):

    query
      │
      ▼
    [0] classify query on raw text (needs_advice_note, needs_considerations)
      │            -- BEFORE retrieval; cheap regex, no I/O
      ▼
    [1] engine.retrieve()                        -- unchanged from rag_engine.py
      │
      ▼
    [2] filter_by_relevance()                    -- NEW, AFTER retrieval / BEFORE generation
      │            -- drops chunks Chroma returned only because it must
      │               return top_k *something*, not because they're relevant
      ▼
    (no chunks survive?) → graceful refusal, generation is skipped entirely
      │
      ▼
    [3] engine._generate()                       -- unchanged from rag_engine.py
      │
      ▼
    [4] post-generation validation                -- NEW, AFTER generation
      4a. citation-existence check on Answer
      4b. Considerations grounding check (drop section if it fails)
      4c. recommendation-leakage safety net (advice-seeking queries only)
      4d. deterministic disclaimer injection into Note
      │
      ▼
    final markdown + sources + guardrail_flags
"""

import random
import re

from rag_engine import _get_engine, reset_engine, needs_advice_note, needs_considerations

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# ASSUMPTION: your Chroma collection uses cosine distance (0 = identical,
# 2 = opposite), which is the common choice for text embedding search and
# what most tutorials set via metadata={"hnsw:space": "cosine"} at
# create_collection time. If ingest.py did NOT set that (Chroma's own
# default is squared L2), this number needs to change.
# To calibrate for your real corpus: run a few queries you know ARE and
# ARE NOT covered by the 5-stock knowledge base, print c["distance"] for
# each returned chunk, and set MAX_RELEVANT_DISTANCE just above the
# "covered" cluster and below the "not covered" cluster.
MAX_RELEVANT_DISTANCE = 0.75  # Lowered from 0.55 to allow comparison/ranking queries

DISCLAIMER_VARIANTS = [
    "This is general information from our research base, not a personal "
    "investment recommendation. For advice tailored to your situation, "
    "please consult a SEBI-registered investment adviser.",
    "Nothing here should be read as a buy/sell recommendation -- it's "
    "factual context only. A SEBI-registered investment adviser can help "
    "you decide what's right for your portfolio.",
    "We're sharing what's in the research base, not financial advice. "
    "Before acting on it, it's worth checking with a SEBI-registered "
    "investment adviser.",
]

# Matches the exact citation format the system prompt asks Gemini for:
# (Source: <filename> — <section>). Em-dash first (the real format), a
# plain-hyphen fallback in case the model doesn't reproduce the em-dash.
# NB: deliberately requires spaces around the dash so filenames that
# themselves contain hyphens (e.g. "TCS-Q4-FY26.pdf") don't get mis-split.
_CITATION_RE = re.compile(r"\(Source:\s*(.+?)\s+—\s+(.+?)\)")
_CITATION_RE_FALLBACK = re.compile(r"\(Source:\s*(.+?)\s+-\s+(.+?)\)")

_SECTION_HEADER_RE = re.compile(r"^\*\*(Answer|Considerations|Note)\*\*\s*$", re.MULTILINE)

# Tight, multi-word patterns to keep false positives low (e.g. "buyback",
# "buying spree" as an industry term should NOT trip this).
_LEAKAGE_RE = re.compile(
    r"\byou should (buy|sell|hold)\b"
    r"|\bi recommend (buying|selling|holding)\b"
    r"|\bis a (good|great|strong|solid) (buy|sell|investment)\b"
    r"|\bstrong buy rating\b"
    r"|\badd (it|this|these|that) to your portfolio\b"
    r"|\b(good|great) time to (buy|sell)\b",
    re.I,
)


# ---------------------------------------------------------------------------
# [2] Relevance filter (post-retrieval, pre-generation)
# ---------------------------------------------------------------------------

def filter_by_relevance(chunks: list, max_distance: float = MAX_RELEVANT_DISTANCE):
    """Drops chunks whose distance is worse than max_distance.

    Chroma's .query() always returns top_k results if the collection (or
    ticker-filtered slice of it) has that many vectors at all -- there is no
    built-in "nothing relevant enough" case. Without this filter, the
    existing `if not chunks` refusal path in rag_engine.py essentially
    never fires for anything except a truly empty collection.
    """
    kept, dropped = [], 0
    for c in chunks:
        d = c.get("distance")
        if d is None or d <= max_distance:
            kept.append(c)
        else:
            dropped += 1
    return kept, dropped


# ---------------------------------------------------------------------------
# [4] Post-generation parsing + validation helpers
# ---------------------------------------------------------------------------

def split_sections(markdown_text: str) -> dict:
    """Splits the model's Answer/Considerations/Note markdown into parts.

    Falls back to treating the whole response as "answer" if the model
    didn't follow the header format -- better a degraded pass-through than
    a crash on a formatting slip.
    """
    matches = list(_SECTION_HEADER_RE.finditer(markdown_text))
    if not matches:
        return {"answer": markdown_text.strip(), "considerations": None, "note": None}

    found = {}
    for i, m in enumerate(matches):
        name = m.group(1).lower()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown_text)
        found[name] = markdown_text[start:end].strip()

    return {
        "answer": found.get("answer", ""),
        "considerations": found.get("considerations") or None,
        "note": found.get("note") or None,
    }


def extract_citations(text: str) -> list:
    """Returns [(filename, section), ...] parsed out of a section's text."""
    if not text:
        return []
    matches = _CITATION_RE.findall(text) or _CITATION_RE_FALLBACK.findall(text)
    return [(fn.strip(), sec.strip()) for fn, sec in matches]


def has_recommendation_leakage(answer_text: str) -> bool:
    return bool(_LEAKAGE_RE.search(answer_text or ""))


def pick_disclaimer(query: str) -> str:
    # random.choice, not query-hashed: variety across queries is the goal
    # here, not per-query determinism. Swap to a hash of `query` instead if
    # you'd rather have identical reruns during a live demo.
    return random.choice(DISCLAIMER_VARIANTS)


def rebuild_markdown(sections: dict) -> str:
    parts = [f"**Answer**\n{sections.get('answer', '')}"]
    if sections.get("considerations"):
        parts.append(f"**Considerations**\n{sections['considerations']}")
    if sections.get("note"):
        parts.append(f"**Note**\n{sections['note']}")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def answer_query(query: str, ticker: str | None = None, portfolio: list = None) -> dict:
    """Guardrailed drop-in replacement for rag_engine.answer_query.

    Returns {"answer": str, "sources": [...], "guardrail_flags": [...]}.
    guardrail_flags is additive -- safe to ignore in the chat UI, useful to
    log for an eval/monitoring dashboard.
    """
    flags = []
    advice_seeking = needs_advice_note(query)          # [0] pre-retrieval classification
    expects_considerations = needs_considerations(query)

    engine = _get_engine()

    try:
        from portfolio_engine import extract_tickers
        from live_ingest import ingest_ticker_live
        from rag_engine import tickers_in_collection
        
        found_tickers = extract_tickers(query)
        if ticker and ticker not in found_tickers:
            found_tickers.append(ticker)
            
        known = tickers_in_collection()
        for t in found_tickers:
            if t not in known and f"{t}.NS" not in known:
                try:
                    ingest_ticker_live(t)
                except Exception:
                    pass
    except Exception:
        pass

    # ---- [1] retrieval (unchanged) ----
    # Self-healing: if Chroma raises a tenant/connection error (happens when
    # the server loaded before ingest.py ran, or after a DB rebuild without
    # a full uvicorn restart), reset the singleton and retry once with a
    # fresh client. Any other exception is a hard failure.
    try:
        raw_chunks = engine.retrieve(query, page_ticker=ticker)
    except Exception as e:
        if "tenant" in str(e).lower() or "connect" in str(e).lower():
            reset_engine()
            try:
                engine = _get_engine()
                raw_chunks = engine.retrieve(query, page_ticker=ticker)
                flags.append({
                    "stage": "retrieval", "type": "info",
                    "detail": "Chroma connection reset and retried successfully.",
                })
            except Exception as e2:
                return {
                    "answer": f"**Answer**\nI wasn't able to search the knowledge base right now ({e2}).",
                    "sources": [],
                    "guardrail_flags": [{"stage": "retrieval", "type": "error", "detail": str(e2)}],
                }
        else:
            return {
                "answer": f"**Answer**\nI wasn't able to search the knowledge base right now ({e}).",
                "sources": [],
                "guardrail_flags": [{"stage": "retrieval", "type": "error", "detail": str(e)}],
            }

    # ---- [2] relevance filter (new) ----
    chunks, n_dropped = filter_by_relevance(raw_chunks)
    if n_dropped:
        flags.append({
            "stage": "post-retrieval", "type": "info",
            "detail": f"Dropped {n_dropped} chunk(s) below the relevance threshold.",
        })

    if not chunks:
        answer_text = "**Answer**\nI don't have information on that."
        if advice_seeking:
            answer_text += f"\n\n**Note**\n{pick_disclaimer(query)}"
        flags.append({
            "stage": "post-retrieval", "type": "refusal",
            "detail": "No sufficiently relevant chunks after threshold filter; generation skipped.",
        })
        return {"answer": answer_text, "sources": [], "guardrail_flags": flags}

    # ---- [3] generation (unchanged) ----
    try:
        raw_answer = engine._generate(query, chunks, portfolio=portfolio)
    except Exception as e:
        return {
            "answer": f"**Answer**\nI retrieved relevant context but generation failed ({e}). Please try again.",
            "sources": engine._build_sources(chunks),
            "guardrail_flags": flags + [{"stage": "generation", "type": "error", "detail": str(e)}],
        }

    # ---- [4] post-generation validation (new) ----
    sections = split_sections(raw_answer)
    allowed_filenames = {
        str(c["metadata"].get("filename", "")).strip().lower() for c in chunks
    }

    # 4a. citation-existence check on the Answer section
    answer_bad = [
        fn for fn, _ in extract_citations(sections["answer"])
        if fn.lower() not in allowed_filenames
    ]
    if answer_bad:
        flags.append({
            "stage": "post-generation", "type": "flag",
            "detail": f"Answer cites source(s) not present in retrieved context: {sorted(set(answer_bad))}",
        })

    # 4b. Considerations must be grounded in the same retrieved chunks, or
    # it gets dropped rather than shown as free-floating commentary.
    if sections["considerations"]:
        cits = extract_citations(sections["considerations"])
        bad = [fn for fn, _ in cits if fn.lower() not in allowed_filenames]
        if not cits or bad:
            reason = "contained no citations at all" if not cits else f"cited unknown source(s): {sorted(set(bad))}"
            flags.append({
                "stage": "post-generation", "type": "flag",
                "detail": f"Considerations section dropped -- {reason}.",
            })
            sections["considerations"] = None
    elif expects_considerations:
        # Query pattern (comparison / risk / horizon language) suggested
        # Considerations was warranted, but there isn't one. Not an error --
        # the model or the grounding check above may have judged the
        # context didn't support it -- but worth a line in the logs.
        flags.append({
            "stage": "post-generation", "type": "info",
            "detail": "Query pattern suggested a Considerations section, but none was present/grounded.",
        })

    # 4c. recommendation-leakage safety net. The system prompt already
    # forbids buy/sell/hold framing; this is a deterministic backstop for
    # the cases where generation doesn't follow that instruction.
    if advice_seeking and has_recommendation_leakage(sections["answer"]):
        flags.append({
            "stage": "post-generation", "type": "flag",
            "detail": "Recommendation-like language detected in Answer; replaced with a safe fallback.",
        })
        sections["answer"] = (
            "I can share factual context from the research base, but I'm not able "
            "to tell you whether to buy, sell, or hold."
        )

    # 4d. deterministic disclaimer -- never let the model freehand the
    # compliance line. Triggered by our own pre-retrieval heuristic OR by
    # the model deciding (per its own system-prompt criteria, which are
    # worded similarly but not identically to ours) that a Note belongs
    # here at all. Either way, once a Note is warranted, its *content* is
    # never the model's -- only ever one of our fixed variants.
    if advice_seeking or sections.get("note"):
        if sections.get("note") and not advice_seeking:
            flags.append({
                "stage": "post-generation", "type": "info",
                "detail": "Model added a Note that our pre-retrieval heuristic didn't flag as "
                          "advice-seeking; overriding with the standard disclaimer anyway.",
            })
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
        print("Usage: python guardrails.py \"<question>\" [TICKER]")
        sys.exit(1)

    q = sys.argv[1]
    t = sys.argv[2] if len(sys.argv) > 2 else None
    result = answer_query(q, t)
    print(result["answer"])
    print("\n--- sources ---")
    print(json.dumps(result["sources"], indent=2))
    print("\n--- guardrail_flags ---")
    print(json.dumps(result["guardrail_flags"], indent=2))