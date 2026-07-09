"""
live_ingest.py — On-demand live data ingestion: yfinance → ChromaDB.

Fetches live market data for any ticker via yfinance, converts it to the
same markdown-chunk format that ingest.py uses for the curated static docs,
embeds each chunk with the Gemini embedding model, and upserts into the
existing Chroma 'stock_research' collection.

This makes the RAG pipeline work for ANY ticker — not just the 5 curated
ones — by populating the DB on demand the first time a ticker is queried.
Subsequent calls are idempotent (upsert, never duplicate).

Public entry points:
    ingest_ticker_live(ticker, chroma_persist_dir="chroma_db") -> int
        Ingest live data for one ticker. Returns number of chunks upserted.

    ticker_in_collection(ticker, chroma_persist_dir="chroma_db") -> bool
        Quick check: does this ticker have ANY chunks in the DB already?

CLI:
    python live_ingest.py WIPRO.NS
    python live_ingest.py TCS.NS --persist-dir chroma_db
"""

from __future__ import annotations

import argparse
import os
import re
from datetime import datetime, date, timedelta
from pathlib import Path

# Load .env (same pattern as every other module in this project)
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _line = _line.strip()
        if _line and not _line.startswith("#") and "=" in _line:
            _k, _v = _line.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"').strip("'"))

import chromadb
import yfinance as yf
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Config — must stay in sync with ingest.py and rag_engine.py
# ---------------------------------------------------------------------------

EMBEDDING_MODEL    = "models/gemini-embedding-001"
COLLECTION_NAME    = "stock_research"
DEFAULT_PERSIST    = "chroma_db"

# How many days of price history to ingest on the first pull
HISTORY_DAYS       = 90

# Chunk size targets (words), same heuristic as ingest.py
TARGET_WORDS       = 300
MIN_WORDS_TO_FLUSH = 120


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _normalize_ticker(ticker: str) -> str:
    return ticker.strip().upper()


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "chunk"


def _chunk_text(text: str, target: int = TARGET_WORDS, min_flush: int = MIN_WORDS_TO_FLUSH) -> list:
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, current, current_words = [], [], 0
    for para in paragraphs:
        pw = len(para.split())
        if current and current_words + pw > target and current_words >= min_flush:
            chunks.append("\n\n".join(current))
            current, current_words = [], 0
        current.append(para)
        current_words += pw
    if current:
        chunks.append("\n\n".join(current))
    return chunks or [text.strip()]


def _embed(client, text: str) -> list:
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=text,
        config=types.EmbedContentConfig(task_type="retrieval_document"),
    )
    return result.embeddings[0].values


# ---------------------------------------------------------------------------
# Data fetchers → markdown text blocks
# ---------------------------------------------------------------------------

def _build_fundamentals_doc(ticker: str, info: dict) -> str:
    name       = info.get("longName") or info.get("shortName") or ticker
    sector     = info.get("sector", "N/A")
    industry   = info.get("industry", "N/A")
    currency   = info.get("currency", "")
    mkt_cap    = info.get("marketCap")
    pe         = info.get("trailingPE")
    eps        = info.get("trailingEps")
    revenue    = info.get("totalRevenue")
    profit_m   = info.get("profitMargins")
    desc       = info.get("longBusinessSummary", "No description available.")
    price      = info.get("currentPrice") or info.get("regularMarketPrice")
    week52_hi  = info.get("fiftyTwoWeekHigh")
    week52_lo  = info.get("fiftyTwoWeekLow")
    div_yield  = info.get("dividendYield")
    beta       = info.get("beta")
    today      = date.today().isoformat()

    lines = [
        f"# {name} ({ticker}) — Live Fundamentals",
        f"SOURCE: Yahoo Finance (yfinance live fetch)",
        f"DATE: {today}",
        "",
        f"## Company Overview",
        f"DATE: {today}",
        f"- **Name**: {name}",
        f"- **Sector**: {sector}",
        f"- **Industry**: {industry}",
        "",
        desc,
        "",
        f"## Key Metrics",
        f"DATE: {today}",
        f"- **Current Price**: {('%s %.2f' % (currency, price)) if price else 'N/A'}",
        f"- **52-Week High**: {('%s %.2f' % (currency, week52_hi)) if week52_hi else 'N/A'}",
        f"- **52-Week Low**: {('%s %.2f' % (currency, week52_lo)) if week52_lo else 'N/A'}",
        f"- **Market Cap**: {('%s %d' % (currency, mkt_cap)) if mkt_cap else 'N/A'}",
        f"- **Trailing P/E**: {('%.2f' % pe) if pe else 'N/A'}",
        f"- **EPS (TTM)**: {('%s %.2f' % (currency, eps)) if eps else 'N/A'}",
        f"- **Total Revenue**: {('%s %d' % (currency, revenue)) if revenue else 'N/A'}",
        f"- **Profit Margin**: {('%.2%' % profit_m) if profit_m else 'N/A'}",
        f"- **Dividend Yield**: {('%.2%' % div_yield) if div_yield else 'N/A'}",
        f"- **Beta**: {('%.2f' % beta) if beta else 'N/A'}",
    ]
    return "\n".join(lines)


def _build_history_doc(ticker: str, series: list) -> str:
    if not series:
        return ""
    today  = date.today().isoformat()
    start  = series[0]["date"]
    end    = series[-1]["date"]
    closes = [pt["close"] for pt in series]
    hi, lo = max(closes), min(closes)
    first, last = closes[0], closes[-1]
    pct_chg = (last - first) / first * 100 if first else 0

    tail = series[-30:]
    price_lines = "\n".join("- %s: %.2f" % (pt["date"], pt["close"]) for pt in tail)

    return "\n".join([
        f"# {ticker} — Price History ({start} to {end})",
        f"SOURCE: Yahoo Finance (yfinance live fetch)",
        f"DATE: {today}",
        "",
        f"## Price Summary ({HISTORY_DAYS}-Day Window)",
        f"DATE: {today}",
        (f"Over the period from {start} to {end}, {ticker} traded between a low of "
         f"{lo:.2f} and a high of {hi:.2f}. The price changed from {first:.2f} to "
         f"{last:.2f}, a {pct_chg:+.2f}% move over this window."),
        "",
        f"## Recent Daily Closes (last 30 sessions)",
        f"DATE: {today}",
        price_lines,
    ])


def _build_news_doc(ticker: str, news_items: list) -> str:
    if not news_items:
        return ""
    today = date.today().isoformat()
    sections = [
        f"# {ticker} — Recent News Headlines",
        f"SOURCE: Yahoo Finance (yfinance live fetch)",
        f"DATE: {today}",
    ]
    for item in news_items[:15]:
        content  = item.get("content", {})
        title    = content.get("title") or item.get("title", "Untitled")
        pub_ts   = content.get("pubDate") or ""
        pub_date = pub_ts[:10] if pub_ts else today
        summary  = content.get("summary") or item.get("summary", "")
        sections += [
            "",
            f"## {title}",
            f"DATE: {pub_date}",
            f"SENTIMENT: neutral",
            summary or "(No summary available.)",
        ]
    return "\n".join(sections)


def _build_balance_sheet_doc(ticker: str, bs: dict) -> str:
    if not bs:
        return ""
    today = date.today().isoformat()
    lines = [
        f"# {ticker} — Balance Sheet (Most Recent Annual)",
        f"SOURCE: Yahoo Finance (yfinance live fetch)",
        f"DATE: {today}",
        "",
        f"## Balance Sheet Line Items",
        f"DATE: {today}",
    ]
    for item, periods in bs.items():
        if periods:
            latest_period = sorted(periods.keys())[-1]
            val = periods[latest_period]
            try:
                lines.append("- **%s** (%s): %s" % (item, latest_period, "{:,.0f}".format(float(val))))
            except (TypeError, ValueError):
                lines.append("- **%s** (%s): %s" % (item, latest_period, val))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Core ingestion
# ---------------------------------------------------------------------------

def _build_all_docs(ticker: str) -> list:
    """Fetch live yfinance data and return (doc_type, section_label, markdown) tuples."""
    stock = yf.Ticker(ticker)
    docs  = []

    # 1. Fundamentals
    try:
        info = stock.info or {}
        if info and info.get("symbol"):
            docs.append(("fundamentals", "live-fundamentals", _build_fundamentals_doc(ticker, info)))
    except Exception as e:
        print(f"  [WARN] Could not fetch info for {ticker}: {e}")

    # 2. Price history
    try:
        start = (date.today() - timedelta(days=HISTORY_DAYS)).isoformat()
        end   = date.today().isoformat()
        hist  = stock.history(start=start, end=end)
        if not hist.empty:
            series = [
                {"date": ts.strftime("%Y-%m-%d"), "close": round(float(c), 2)}
                for ts, c in hist["Close"].items()
            ]
            md = _build_history_doc(ticker, series)
            if md:
                docs.append(("fundamentals", "live-price-history", md))
    except Exception as e:
        print(f"  [WARN] Could not fetch history for {ticker}: {e}")

    # 3. News
    try:
        news = stock.news or []
        if news:
            md = _build_news_doc(ticker, news)
            if md:
                docs.append(("news", "live-news", md))
    except Exception as e:
        print(f"  [WARN] Could not fetch news for {ticker}: {e}")

    # 4. Balance sheet
    try:
        df = stock.balance_sheet
        if df is not None and not df.empty:
            df = df.rename(
                columns=lambda c: c.strftime("%Y-%m-%d") if hasattr(c, "strftime") else str(c)
            )
            bs = {str(idx): row.to_dict() for idx, row in df.iterrows()}
            md = _build_balance_sheet_doc(ticker, bs)
            if md:
                docs.append(("filings", "live-balance-sheet", md))
    except Exception as e:
        print(f"  [WARN] Could not fetch balance sheet for {ticker}: {e}")

    return docs


def ingest_ticker_live(ticker: str, chroma_persist_dir: str = DEFAULT_PERSIST) -> int:
    """
    Fetch live yfinance data for `ticker`, embed with Gemini, upsert into Chroma.
    Returns number of chunks upserted. Safe to call repeatedly (idempotent).
    """
    ticker = _normalize_ticker(ticker)
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set.")

    genai_client  = genai.Client(api_key=api_key)
    chroma_client = chromadb.PersistentClient(path=chroma_persist_dir)
    collection    = chroma_client.get_or_create_collection(name=COLLECTION_NAME)

    today    = date.today().isoformat()
    docs     = _build_all_docs(ticker)
    filename = "%s_live_%s.md" % (ticker.lower(), today)

    ids, texts, metadatas, embeddings = [], [], [], []

    for doc_type, section_label, markdown_text in docs:
        chunks = _chunk_text(markdown_text)
        for idx, chunk_text in enumerate(chunks):
            chunk_id = "%s_%s_%s_%d_live" % (ticker, doc_type, _slug(section_label), idx)
            metadata = {
                "ticker":    ticker,
                "doc_type":  doc_type,
                "filename":  filename,
                "section":   section_label,
                "source":    "Yahoo Finance (live)",
                "date":      today,
                "sentiment": "",
            }
            try:
                emb = _embed(genai_client, chunk_text)
            except Exception as e:
                print(f"  [ERROR] Embedding failed for {chunk_id}: {e}")
                continue
            ids.append(chunk_id)
            texts.append(chunk_text)
            metadatas.append(metadata)
            embeddings.append(emb)

    if ids:
        collection.upsert(ids=ids, documents=texts, metadatas=metadatas, embeddings=embeddings)
        print(f"  [OK] {ticker}: {len(ids)} live chunk(s) upserted into '{COLLECTION_NAME}'")

    return len(ids)


def ticker_in_collection(ticker: str, chroma_persist_dir: str = DEFAULT_PERSIST) -> bool:
    """Returns True if `ticker` already has chunks in the Chroma collection."""
    ticker = _normalize_ticker(ticker)
    try:
        chroma_client = chromadb.PersistentClient(path=chroma_persist_dir)
        collection    = chroma_client.get_or_create_collection(name=COLLECTION_NAME)
        results       = collection.get(where={"ticker": ticker}, limit=1, include=[])
        return bool(results.get("ids"))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Live-ingest yfinance data for a ticker into ChromaDB."
    )
    parser.add_argument("ticker", help="Ticker symbol (e.g. TCS.NS, WIPRO.NS, AAPL)")
    parser.add_argument(
        "--persist-dir", default=DEFAULT_PERSIST,
        help="Path to the Chroma persist directory (default: chroma_db)"
    )
    args = parser.parse_args()
    n = ingest_ticker_live(args.ticker, chroma_persist_dir=args.persist_dir)
    print(f"\nDone. {n} chunk(s) upserted for {args.ticker.upper()}.")
