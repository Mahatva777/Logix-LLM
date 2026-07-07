"""
rag_engine.py — Retrieval + grounded generation for the AI Research Assistant.

Public entry point:
    answer_query(query: str, ticker: str | None) -> dict
        Returns {"answer": <markdown str>, "sources": [{"file": ..., "snippet": ...}]}

Pipeline:
    1. Detect ticker(s) actually referenced in the query text. This matters
       because the chat widget is embedded on a single stock's detail page
       (so `ticker` is that page's stock), but a user can still type a
       cross-ticker question like "Compare HDFC vs ICICI margins" while
       sitting on the HDFC page. When that happens we widen retrieval to
       cover every ticker mentioned, not just the page's ticker.
    2. Retrieve top-k chunks per relevant ticker from Chroma (embedding the
       query with Gemini, task_type="retrieval_query").
    3. Build a context block that labels every chunk with its source file,
       section, and ticker.
    4. Ask Gemini to answer strictly from that context, in a fixed
       Answer / Considerations / Note structure (Considerations and Note are
       conditionally included — see heuristics below).
    5. Return the markdown answer plus a deduped source list for the UI to
       render as citation chips/links.
"""

import os
import re
from pathlib import Path

import chromadb
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Config — must match ingest.py
# ---------------------------------------------------------------------------

EMBEDDING_MODEL = "models/gemini-embedding-001"
GENERATION_MODEL = "gemini-2.5-flash"
PERSIST_DIR = "chroma_db"
COLLECTION_NAME = "stock_research"
TOP_K_SINGLE = 6      # chunks retrieved when the query targets one ticker (or none)
TOP_K_PER_TICKER = 4  # chunks retrieved PER ticker when comparing two+

# Known universe for this hackathon build (5-stock scope). Aliases let us
# detect a ticker even when the user types the company name instead of the
# ticker symbol.
TICKER_ALIASES = {
    "TCS": ["tcs", "tata consultancy"],
    "HDFC": ["hdfc bank", "hdfc"],
    "ICICI": ["icici bank", "icici"],
    "INFY": ["infosys", "infy"],
    "RELIANCE": ["reliance industries", "reliance", "ril"],
}

# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are the AI Research Assistant embedded on MoneyLogix's stock detail pages. You answer questions about Indian-listed stocks using ONLY the retrieved context supplied to you below — you have no other knowledge of these companies, their financials, or current events, and must not use any outside knowledge, even if you believe it to be true.

Hard rules:
1. Every factual claim must be grounded in the retrieved context and must carry an inline citation in the form (Source: <filename> — <section>). Do not cite a source for a claim it doesn't actually support.
2. Never invent, estimate, or infer numbers, dates, or events that are not present in the retrieved context, even if it seems like a reasonable guess.
3. If the retrieved context does not contain enough information to answer the question (in whole or in part), say so plainly: "I don't have information on that." Do not fill the gap from outside knowledge.
4. You are not a financial advisor. Never issue buy/sell/hold recommendations, price targets, or portfolio allocation advice, even if asked directly — redirect to what the grounded context does say instead.

Response format:
Structure your entire response using exactly these Markdown section headers, in this order, with no other headers, preambles, or closing remarks:

**Answer**
The direct, grounded response to the question, with inline citations after every factual claim.

**Considerations**
Include this section ONLY if the question involves risk, time horizon, liquidity, or a recommendation-adjacent framing (e.g. a comparison that implies "which is better," or a question about timing, safety, or outlook). When included, draw these notes ONLY from risk/outlook language already present in the retrieved context — never introduce a risk factor, implication, or opinion that isn't explicitly there. Omit this entire section (header included) for pure factual lookups such as "what was revenue last quarter."

**Note**
Include this section ONLY if the question edges toward investment advice (e.g. asks whether to buy/sell/invest, what's a "good" stock right now, or otherwise implies a recommendation is wanted). When included, it must contain exactly this line and nothing else:
This is for informational purposes only and is not investment advice. Please consult a SEBI-registered investment advisor before making investment decisions.
Omit this entire section (header included) for factual or comparative questions that are not asking for a recommendation."""

USER_PROMPT_TEMPLATE = """Retrieved context ({num_chunks} chunk(s), each labeled with its source):

{context_block}

Question: {query}

Answer strictly following the system instructions and response format above. If some part of the question isn't covered by the context above, say so explicitly for that part rather than skipping it silently."""

CHUNK_TEMPLATE = """[{idx}] Ticker: {ticker} | File: {filename} | Section: {section} | Date: {date}{sentiment_part}
Source: {source}
{text}"""

# ---------------------------------------------------------------------------
# Heuristics for conditional sections
# ---------------------------------------------------------------------------

COMPARISON_PATTERN = re.compile(r"\b(vs\.?|versus|compare|comparison|difference between)\b", re.I)
RISK_TIME_PATTERN = re.compile(
    r"\b(risk|time horizon|timing|horizon|liquidity|volatil|safe|safety|outlook|hold|entry point)\b", re.I
)
ADVICE_PATTERN = re.compile(
    r"\b(should i|buy|sell|invest|worth (buying|it)|good (buy|investment|time to buy)|"
    r"recommend|better (buy|choice|pick)|portfolio|allocate|is it a good stock)\b", re.I
)


def needs_considerations(query: str) -> bool:
    return bool(COMPARISON_PATTERN.search(query) or RISK_TIME_PATTERN.search(query) or ADVICE_PATTERN.search(query))


def needs_advice_note(query: str) -> bool:
    return bool(ADVICE_PATTERN.search(query))


def detect_tickers(query: str) -> list:
    """Returns tickers explicitly referenced in the query text (order-preserving)."""
    q = query.lower()
    found = []
    for ticker, aliases in TICKER_ALIASES.items():
        if any(alias in q for alias in aliases):
            found.append(ticker)
    return found


# ---------------------------------------------------------------------------
# Retrieval
# ---------------------------------------------------------------------------

class RagEngine:
    def __init__(self, persist_dir: str = PERSIST_DIR, collection_name: str = COLLECTION_NAME, api_key: str = None):
        api_key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable is not set.")
        self.client = genai.Client(api_key=api_key)

        if not Path(persist_dir).exists():
            raise FileNotFoundError(
                f"Chroma persist directory not found: {persist_dir}. Run ingest.py first."
            )
        
        try:
            chroma_client = chromadb.PersistentClient(path=persist_dir)
            self.collection = chroma_client.get_collection(collection_name)
        except Exception as e:
            import traceback
            print(f"Exception during Chroma initialization: {e}")
            traceback.print_exc()
            raise

    def _embed_query(self, text: str) -> list:
        result = self.client.models.embed_content(
            model=EMBEDDING_MODEL,
            contents=text,
            config=types.EmbedContentConfig(task_type="retrieval_query"),
        )
        return result.embeddings[0].values

    def _query_chroma(self, query: str, top_k: int, ticker: str = None) -> dict:
        embedding = self._embed_query(query)
        where = {"ticker": ticker} if ticker else None
        return self.collection.query(query_embeddings=[embedding], n_results=top_k, where=where)

    def retrieve(self, query: str, page_ticker: str = None) -> list:
        """
        Returns a list of dicts: {id, text, metadata}.
        If the query names one or more tickers explicitly, those take
        precedence over the page's ticker context and we fetch top_k PER
        ticker (so a comparison can't get crowded out by one side having
        more semantically similar chunks). Otherwise we fall back to the
        page's ticker (if any), or an unfiltered search.
        """
        detected = detect_tickers(query)
        target_tickers = detected if detected else ([page_ticker.upper()] if page_ticker else [])

        seen_ids = set()
        chunks = []

        if len(target_tickers) >= 2:
            for t in target_tickers:
                res = self._query_chroma(query, top_k=TOP_K_PER_TICKER, ticker=t)
                chunks.extend(self._flatten(res, seen_ids))
        elif len(target_tickers) == 1:
            res = self._query_chroma(query, top_k=TOP_K_SINGLE, ticker=target_tickers[0])
            chunks.extend(self._flatten(res, seen_ids))
        else:
            res = self._query_chroma(query, top_k=TOP_K_SINGLE, ticker=None)
            chunks.extend(self._flatten(res, seen_ids))

        return chunks

    @staticmethod
    def _flatten(chroma_result: dict, seen_ids: set) -> list:
        out = []
        ids = chroma_result.get("ids", [[]])[0]
        docs = chroma_result.get("documents", [[]])[0]
        metas = chroma_result.get("metadatas", [[]])[0]
        for cid, doc, meta in zip(ids, docs, metas):
            if cid in seen_ids:
                continue
            seen_ids.add(cid)
            out.append({"id": cid, "text": doc, "metadata": meta or {}})
        return out

    # -----------------------------------------------------------------
    # Prompt assembly + generation
    # -----------------------------------------------------------------

    @staticmethod
    def _build_context_block(chunks: list) -> str:
        blocks = []
        for i, c in enumerate(chunks, start=1):
            meta = c["metadata"]
            sentiment_part = f" | Sentiment: {meta['sentiment']}" if meta.get("sentiment") else ""
            blocks.append(CHUNK_TEMPLATE.format(
                idx=i,
                ticker=meta.get("ticker", "?"),
                filename=meta.get("filename", "?"),
                section=meta.get("section", "?"),
                date=meta.get("date", "?"),
                sentiment_part=sentiment_part,
                source=meta.get("source", "?"),
                text=c["text"],
            ))
        return "\n\n".join(blocks)

    def _generate(self, query: str, chunks: list) -> str:
        context_block = self._build_context_block(chunks)
        user_prompt = USER_PROMPT_TEMPLATE.format(
            num_chunks=len(chunks), context_block=context_block, query=query
        )
        response = self.client.models.generate_content(
            model=GENERATION_MODEL,
            contents=user_prompt,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                temperature=0.2,  # low temperature: grounded factual synthesis, not creative writing
            ),
        )
        return response.text

    @staticmethod
    def _build_sources(chunks: list) -> list:
        sources = []
        seen = set()
        for c in chunks:
            meta = c["metadata"]
            key = (meta.get("filename"), meta.get("section"))
            if key in seen:
                continue
            seen.add(key)
            snippet = c["text"][:200] + ("..." if len(c["text"]) > 200 else "")
            sources.append({"file": meta.get("filename", "unknown"), "snippet": snippet})
        return sources

    def answer_query(self, query: str, ticker: str = None) -> dict:
        try:
            chunks = self.retrieve(query, page_ticker=ticker)
        except Exception as e:
            return {
                "answer": f"**Answer**\nI wasn't able to search the knowledge base right now ({e}).",
                "sources": [],
            }

        if not chunks:
            return {
                "answer": "**Answer**\nI don't have information on that.",
                "sources": [],
            }

        try:
            answer_text = self._generate(query, chunks)
        except Exception as e:
            return {
                "answer": f"**Answer**\nI retrieved relevant context but generation failed ({e}). "
                          f"Please try again.",
                "sources": self._build_sources(chunks),
            }

        return {"answer": answer_text, "sources": self._build_sources(chunks)}


# ---------------------------------------------------------------------------
# Module-level convenience function (what the rest of the app imports)
# ---------------------------------------------------------------------------

_engine = None


def reset_engine() -> None:
    """Force the singleton to re-initialize on the next call.
    Call this if Chroma raises a tenant/connection error after a DB rebuild.
    """
    global _engine
    _engine = None


def _get_engine() -> RagEngine:
    global _engine
    if _engine is None:
        _engine = RagEngine()
    return _engine


def answer_query(query: str, ticker: str | None = None) -> dict:
    """
    Answers a natural-language question about a stock, grounded via RAG.

    Args:
        query: the user's question, e.g. "Summarise TCS's latest results"
               or "Compare HDFC vs ICICI margins".
        ticker: the ticker of the stock detail page the chat is embedded on
                (e.g. "TCS"), or None if there's no page context. This is a
                *default* filter — if the query text itself names one or
                more tickers, those take precedence (see retrieve()).

    Returns:
        {"answer": <markdown str with Answer/Considerations/Note sections>,
         "sources": [{"file": <filename>, "snippet": <chunk excerpt>}, ...]}
    """
    engine = _get_engine()
    return engine.answer_query(query, ticker=ticker)


if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python rag_engine.py \"<question>\" [TICKER]")
        sys.exit(1)

    q = sys.argv[1]
    t = sys.argv[2] if len(sys.argv) > 2 else None
    result = answer_query(q, t)
    print(result["answer"])
    print("\n--- sources ---")
    print(json.dumps(result["sources"], indent=2))