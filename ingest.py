"""
ingest.py — Ingests curated markdown reference docs into a local Chroma
collection, embedded via the Gemini embeddings API.

Each markdown file is expected to follow the convention used across this
project's reference docs:
    # Title
    SOURCE: <where this info is meant to have come from>
    DATE: <date, at file level and/or per section>
    ## Section heading
    SENTIMENT: <positive|neutral|negative>   (news files only, per section)
    <paragraph text>
    ## Next section heading
    ...

Usage:
    export GEMINI_API_KEY="your-key-here"
    python ingest.py --data-dir data --persist-dir chroma_db
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import chromadb
from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

EMBEDDING_MODEL = "models/gemini-embedding-001"
COLLECTION_NAME = "stock_research"

# Rough word-count targets standing in for a ~300-500 token chunk
# (heuristic: 1 token ~= 0.75 words for English prose, so 300-500 tokens
# is roughly 225-375 words). We chunk on paragraph boundaries within a
# section and flush a chunk once it crosses TARGET_WORDS.
TARGET_WORDS = 300
MIN_WORDS_TO_FLUSH = 120  # avoid emitting tiny trailing chunks where avoidable

DOC_TYPES = {"fundamentals", "filings", "news"}


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Chunk:
    text: str
    ticker: str
    doc_type: str
    filename: str
    section: str
    source: str
    date: str
    sentiment: str
    chunk_index: int

    def id(self) -> str:
        section_slug = re.sub(r"[^a-z0-9]+", "-", self.section.lower()).strip("-") or "section"
        return f"{self.ticker}_{self.doc_type}_{section_slug}_{self.chunk_index}"

    def metadata(self) -> dict:
        return {
            "ticker": self.ticker,
            "doc_type": self.doc_type,
            "filename": self.filename,
            "section": self.section,
            "source": self.source,
            "date": self.date,
            "sentiment": self.sentiment,
        }


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def infer_doc_type(filename: str) -> str:
    stem = filename.lower()
    for dt in DOC_TYPES:
        if dt in stem:
            return dt
    return "unknown"


def extract_top_level_field(text: str, field_name: str) -> str:
    """Grab a 'FIELD: value' line that appears before the first '## ' heading."""
    header_split = text.split("\n## ", 1)[0]
    match = re.search(rf"^{field_name}:\s*(.+)$", header_split, re.MULTILINE)
    return match.group(1).strip() if match else ""


def split_into_sections(text: str):
    """
    Splits a markdown doc into (section_title, section_body) pairs based on
    '## ' headings. Content before the first '## ' (title + SOURCE/DATE
    preamble) is dropped here since it's captured as file-level metadata.
    Returns a list of (title, body) tuples in document order.
    """
    parts = re.split(r"^## (.+)$", text, flags=re.MULTILINE)
    # parts = [preamble, heading1, body1, heading2, body2, ...]
    sections = []
    for i in range(1, len(parts), 2):
        title = parts[i].strip()
        body = parts[i + 1].strip() if i + 1 < len(parts) else ""
        sections.append((title, body))
    if not sections:
        # No '## ' headings found; treat whole doc as one section.
        sections = [("Full Document", text.strip())]
    return sections


def extract_section_field(body: str, field_name: str) -> str:
    match = re.search(rf"^{field_name}:\s*(.+)$", body, re.MULTILINE)
    return match.group(1).strip() if match else ""


def strip_metadata_lines(body: str) -> str:
    """Remove DATE:/SENTIMENT: lines from a section body, leaving prose only."""
    lines = [
        ln for ln in body.splitlines()
        if not re.match(r"^(DATE|SENTIMENT):\s*", ln)
    ]
    return "\n".join(lines).strip()


def chunk_paragraphs(paragraphs, target_words=TARGET_WORDS):
    """Greedily groups paragraphs into chunks close to target_words."""
    chunks, current, current_words = [], [], 0
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        para_words = len(para.split())
        if current and current_words + para_words > target_words and current_words >= MIN_WORDS_TO_FLUSH:
            chunks.append("\n\n".join(current))
            current, current_words = [], 0
        current.append(para)
        current_words += para_words
    if current:
        chunks.append("\n\n".join(current))
    return chunks


# ---------------------------------------------------------------------------
# Core ingestion
# ---------------------------------------------------------------------------

def build_chunks_for_file(filepath: Path, ticker: str) -> list:
    text = filepath.read_text(encoding="utf-8")
    doc_type = infer_doc_type(filepath.name)
    file_source = extract_top_level_field(text, "SOURCE")
    file_date = extract_top_level_field(text, "DATE")

    chunks = []
    for section_title, body in split_into_sections(text):
        section_date = extract_section_field(body, "DATE") or file_date
        section_sentiment = extract_section_field(body, "SENTIMENT")
        clean_body = strip_metadata_lines(body)
        paragraphs = [p for p in clean_body.split("\n\n") if p.strip()]

        for idx, chunk_text in enumerate(chunk_paragraphs(paragraphs)):
            chunks.append(Chunk(
                text=chunk_text,
                ticker=ticker,
                doc_type=doc_type,
                filename=filepath.name,
                section=section_title,
                source=file_source,
                date=section_date,
                sentiment=section_sentiment,
                chunk_index=idx,
            ))
    return chunks


def discover_files(data_dir: Path):
    """Yields (ticker, filepath) for every .md file under data_dir/<TICKER>/."""
    if not data_dir.exists():
        raise FileNotFoundError(f"Data directory not found: {data_dir}")

    ticker_dirs = [d for d in data_dir.iterdir() if d.is_dir()]
    if not ticker_dirs:
        raise FileNotFoundError(f"No ticker subfolders found inside: {data_dir}")

    for ticker_dir in sorted(ticker_dirs):
        md_files = sorted(ticker_dir.glob("*.md"))
        if not md_files:
            print(f"  [WARN] No markdown files found for ticker '{ticker_dir.name}' — skipping.")
            continue
        for f in md_files:
            yield ticker_dir.name.upper(), f


def embed_text(client: "genai.Client", text: str) -> list:
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=text,
        config=types.EmbedContentConfig(task_type="retrieval_document"),
    )
    return result.embeddings[0].values


def main():
    parser = argparse.ArgumentParser(description="Ingest markdown stock docs into Chroma via Gemini embeddings.")
    parser.add_argument("--data-dir", default="data", help="Root folder containing <TICKER>/ subfolders of .md files")
    parser.add_argument("--persist-dir", default="chroma_db", help="Folder for the persistent Chroma store")
    parser.add_argument("--collection", default=COLLECTION_NAME, help="Chroma collection name")
    parser.add_argument("--reset", action="store_true", help="Delete and recreate the collection before ingesting")
    args = parser.parse_args()

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        print("[ERROR] GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable is not set.")
        sys.exit(1)
    client = genai.Client(api_key=api_key)

    data_dir = Path(args.data_dir)
    try:
        files = list(discover_files(data_dir))
    except FileNotFoundError as e:
        print(f"[ERROR] {e}")
        sys.exit(1)

    print(f"Found {len(files)} markdown file(s) across {len(set(t for t, _ in files))} ticker(s).\n")

    chroma_client = chromadb.PersistentClient(path=args.persist_dir)
    if args.reset:
        try:
            chroma_client.delete_collection(args.collection)
            print(f"[INFO] Existing collection '{args.collection}' deleted (--reset).")
        except Exception:
            pass
    collection = chroma_client.get_or_create_collection(name=args.collection)

    total_chunks = 0
    total_errors = 0

    for ticker, filepath in files:
        try:
            chunks = build_chunks_for_file(filepath, ticker)
        except Exception as e:
            print(f"  [ERROR] Failed to parse {filepath}: {e}")
            total_errors += 1
            continue

        if not chunks:
            print(f"  [WARN] {filepath.name} ({ticker}) produced no chunks — check formatting.")
            continue

        ids, texts, metadatas, embeddings = [], [], [], []
        for chunk in chunks:
            try:
                embedding = embed_text(client, chunk.text)
            except Exception as e:
                print(f"  [ERROR] Embedding failed for {chunk.id()}: {e}")
                total_errors += 1
                continue
            ids.append(chunk.id())
            texts.append(chunk.text)
            metadatas.append(chunk.metadata())
            embeddings.append(embedding)

        if ids:
            collection.upsert(ids=ids, documents=texts, metadatas=metadatas, embeddings=embeddings)
            total_chunks += len(ids)
            print(f"  [OK] {ticker:<6} {filepath.name:<28} -> {len(ids)} chunk(s) embedded & stored")

    print("\n--- Ingestion summary ---")
    print(f"Chunks stored : {total_chunks}")
    print(f"Errors        : {total_errors}")
    print(f"Collection    : '{args.collection}' at '{args.persist_dir}'")
    print(f"Total in DB   : {collection.count()}")


if __name__ == "__main__":
    main()
