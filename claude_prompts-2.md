# Claude Prompts — AI Research Assistant Build

Each fresh Claude chat has zero memory of this project. So: **paste the CONTEXT block below at the top of every new chat**, then paste the specific step's prompt right after it. Where a prompt says `[PASTE ...]`, actually paste the real content (your data, your code, the error message) — don't leave the placeholder in.

## The differentiator (and what's deliberately NOT being built)

**Building:** every answer follows a structured, SEBI-aware reasoning template — context → risk/horizon/liquidity considerations → grounded answer → compliance disclaimer — instead of a flat chatbot reply. This is pure prompt engineering on top of the RAG core, near-zero extra infrastructure, and it's the brief's own named stretch goal for this project ("guardrails against unsupported financial advice"). Bonus, near-free: news snippets get a sentiment tag at curation time, so the assistant can reference market mood.

**Deliberately NOT building:** bulk/block-deal ingestion, internal research-notes ingestion, a portfolio/Position-Doctor module, RBAC, caching infra, saved-queries/export UI. These stay as **roadmap talking points** for the README and discussion round — same narrative credit, zero build-time risk to the 30%-weighted functionality score.

---

## CONTEXT BLOCK (paste this into every new chat, every time)

```
I'm building "AI Research Assistant" for a hackathon run by MoneyLogix, a stock
broking platform. This is an intern hiring hackathon — PPOs are tied to project
difficulty and judged on: functionality (30%), code quality (20%), UX (15%),
production-readiness (10%), video/deck (10%), plus a separate discussion round
(15%) where I have to defend every design decision live and unscripted.

The project: a natural-language assistant that answers questions about a stock,
grounded via RAG over fundamentals, filings, and news, with source citations on
every answer, embedded as a chat UI on a stock detail page. Two example queries
that must work well: "Summarise TCS's latest results" and "Compare HDFC vs ICICI
margins."

Scope decisions already locked in:
- 5 stocks only: TCS, HDFC Bank, ICICI Bank, Infosys, Reliance
- Data is mocked/curated (explicitly allowed by the brief), not live-scraped
- Stack: Python + FastAPI backend, Chroma as the vector store, Gemini API
  (free tier) for embeddings + generation, React + Tailwind frontend
- I'm comfortable with Python, FastAPI, LangChain, and prompt engineering,
  working under a tight time budget — I need runnable code, not pseudocode,
  and concise explanations, not lecture-length ones.

My chosen differentiator: every answer should follow a structured,
SEBI-aware reasoning format (context -> risk/horizon/liquidity considerations
-> grounded answer -> compliance disclaimer), not a flat chatbot reply. This
is prompt-engineering, not new infrastructure. I'm deliberately NOT building
bulk-deal data, a portfolio module, RBAC, or caching — those are roadmap
talking points only, not build targets.

Don't ask me to clarify unless you're genuinely blocked — make sensible
assumptions, state them in one line, then give me the working solution.
```

---

## Step 1 — Structure raw data into RAG-ready docs

```
Using the context above: I've gathered raw material for [STOCK NAME] —
[PASTE: latest quarter numbers, 2-3 filing/announcement summaries, 5-10 news
headlines or snippets you sourced].

Turn this into clean, RAG-ready reference documents: one markdown file for
"fundamentals", one for "filings", one for "news" — each with a clear title,
a date, and short paragraphs (not fragment bullets) so they chunk well for
embedding. At the top of each file add a "SOURCE:" line naming where that
info is meant to have come from, so I can cite it later.

For the news file specifically: tag each snippet with a one-word sentiment
(positive / neutral / negative) based on its actual content — don't invent
tone that isn't there. Add it as "SENTIMENT:" right under each snippet's date.

Do this for [STOCK NAME] now. I'll paste raw notes for the next stock in a
follow-up message once this one's done.
```
*(Repeat this per stock — 5 times total, in the same chat so context carries over.)*

---

## Step 2 — Ingestion pipeline (chunk, embed, store)

```
Using the context above: write a Python ingestion script (ingest.py) that:
1. Reads all markdown files from a data/<TICKER>/ folder structure
2. Chunks them sensibly (~300-500 tokens), keeping source metadata attached
   to each chunk (filename + section)
3. Embeds each chunk using the Gemini embeddings API
4. Stores them in a local Chroma collection with that metadata preserved,
   so I can cite the source later at answer time

Include error handling for missing files and clear console output so I can
confirm it worked. After the code, list the 3-4 key design decisions you made
(chunk size, metadata schema, why Chroma) as short bullets — I need to be able
to explain these in a discussion round.
```

---

## Step 3 — Retrieval + generation chain (the core RAG engine)

```
Using the context above: write a Python module (rag_engine.py) with a function
answer_query(query: str, ticker: str | None) -> dict that:
1. Retrieves the top-k most relevant chunks from the Chroma store built in
   ingest.py (optionally filtered by ticker)
2. Builds a prompt instructing the LLM to:
   a. Answer ONLY from retrieved context, cite the source file/section for
      every claim, and say "I don't have information on that" if context
      doesn't cover the question
   b. Structure every response in this exact shape, using these section
      labels, and only include the "Considerations" section when the
      question involves risk, timing, or a recommendation-adjacent framing
      (skip it for pure factual lookups like "what was Q1 revenue"):
      - **Answer** (the direct, grounded response with inline citations)
      - **Considerations** (brief notes on risk, time horizon, or liquidity
        drawn ONLY from what's in the retrieved context — never invented)
      - **Note** (a one-line compliance disclaimer, only when the question
        edges toward advice — see step 4 for exact wording)
3. Calls the Gemini API for generation
4. Returns {answer: str, sources: [{file, snippet}]} where "answer" contains
   the full structured response as markdown

Show me the exact system/user prompt template you used — I need to explain
both the grounding strategy AND the structured-reasoning design choice in a
discussion round (why this format, why it's not just decoration). Make sure
it correctly handles both: "Summarise TCS's latest results" (single-ticker,
no Considerations needed) and "Compare HDFC vs ICICI margins" (two tickers
at once, likely warrants a brief Considerations note on what the margin gap
implies about business mix — grounded in context, not invented advice).
```

---

## Step 4 — Guardrails & safety layer

```
Using the context above: I have a working rag_engine.py with an
answer_query() function that already produces structured Answer /
Considerations / Note sections [PASTE the code from step 3].

Add a guardrails layer that:
1. Detects queries asking for direct financial advice (e.g. "should I buy X",
   "will X go up") and responds with a neutral, factual answer plus this kind
   of Note instead of a recommendation: a short, plain-language disclaimer
   stating this is informational/research context only, not investment
   advice, and that a SEBI-registered investment adviser should be consulted
   for personalised recommendations. Write 2-3 short variants of this wording
   so it doesn't feel copy-pasted every time.
2. Refuses gracefully (not a hard error) when no relevant context is retrieved
3. Never fabricates numbers, risk claims, or sentiment not present in the
   retrieved chunks — the Considerations section must be checkable against
   the same cited sources as the Answer section, not free-floating commentary
4. Validates that if a Considerations section is present, it's actually
   grounded — flag (don't just silently pass) any generated Considerations
   text that doesn't map back to a retrieved chunk

Tell me exactly where in the pipeline each check sits (before/after
retrieval, before/after generation) and why — I need to defend both the
disclaimer wording choice and the placement in a discussion round.
```

---

## Step 5 — Streaming endpoint

```
Using the context above: I have rag_engine.py with answer_query()
[PASTE the code, including guardrails from step 4].

Wrap this in a FastAPI endpoint POST /chat that accepts {query, ticker} and
streams the answer back token-by-token using Server-Sent Events, sending the
sources array as a final event once generation completes.

Give me the full FastAPI route code plus a 2-line curl example to test it.
```

---

## Step 6 — Frontend chat UI

```
Using the context above: my teammate has ~5 hours to build the frontend.
Build a single-file React component (Tailwind classes only, no external UI
library) for a mock stock detail page for TCS showing:
1. A fundamentals summary panel (static/mocked data is fine)
2. An embedded chat panel

The chat panel needs: message history, a text input, streaming text rendering
(appending tokens as they arrive via SSE from POST /chat), and small citation
badges under each assistant message showing the source file name on hover or
click.

Assistant responses arrive as markdown with up to three sections: **Answer**,
**Considerations**, and **Note** (a compliance disclaimer — not always
present). Render these as visually distinct blocks, not one wall of text —
e.g. Answer in the normal message bubble, Considerations in a subtly
highlighted sub-panel, Note in a small muted disclaimer strip at the bottom.
This visual separation is the whole point: a judge should see the structured-
reasoning differentiator in about 5 seconds of looking at the demo, without
reading the copy closely.

Keep it in one file, functional component, sensible defaults, a clean modern
fintech look — not a generic gray chatbot box.
```

---

## Step 7 — Integration debugging

```
Using the context above: I have a FastAPI backend running locally at
http://localhost:8000/chat (SSE endpoint) and this React component trying to
call it: [PASTE your component code].

I'm hitting this problem: [PASTE the exact error or describe the broken
behavior — e.g. CORS error, connection refused, SSE not parsing, streaming
text not appearing].

Diagnose the likely cause and give me the exact fix, including any FastAPI
CORS middleware config needed and any frontend fetch/EventSource changes.
```

---

## Step 8 — Testing / edge cases

```
Using the context above: here's my current rag_engine.py and guardrails code
[PASTE it].

Generate 10 tricky test queries that would expose weaknesses: ambiguous
tickers, questions with no supported data, direct "should I buy" questions,
cross-ticker comparisons, questions about companies outside my 5-stock set,
and adversarial prompts trying to force a definitive buy/sell call.

For each query, tell me what the ideal response looks like so I can manually
verify my system handles it correctly before submission.
```

---

## Step 9 — README

```
Using the context above: write a README.md covering:
1. Problem statement — frame this as more than a Q&A bot: it's a structured,
   compliance-aware research layer that sits between raw data and an
   analyst/trader, producing grounded answers, risk/horizon considerations,
   and appropriate disclaimers in one pass
2. Architecture overview — include a simple text/ASCII diagram of the data
   flow: markdown docs -> chunk/embed -> Chroma -> retrieval -> structured
   Gemini generation (Answer/Considerations/Note) -> FastAPI -> React chat UI
3. Setup/run instructions (assume Python 3.11, Node 18+, .env for API keys)
4. What's done vs pending
5. A "how this scales to production" section covering, as clearly-labeled
   FUTURE WORK (not built): ingesting live NSE bulk/block-deal data and
   internal research notes into the same RAG pipeline, a portfolio-level
   module that reuses the same reasoning engine to explain holdings-level
   risk, RBAC for internal vs client-facing views, and caching/rate-limiting
   for production traffic. Be explicit that these are deliberate scope cuts
   for the hackathon window, not oversights — that's a stronger signal than
   pretending they were never considered.

Keep it concise and skimmable, not a wall of text — judges score this
directly.
```
