# AI Research Assistant — 16-Hour Build Plan (MoneyLogix Hackathon)

**Project G** — likely ₹6 LPA (Medium) tier based on the brief's structure. Confirm with organizers if unsure.

## What judges actually want (from the rubric)
- Functionality (30%): Q&A that's actually grounded, not hallucinated
- Code quality (20%): clean, readable, error-handled
- UX (15%): feels like a real chat panel on a stock page, not a demo script
- Production-readiness (10%): could this scale? security/data handling thought through?
- Video/deck (10%)
- **Discussion round (15%)** — this is separate and comes later; you must be able to defend every decision live

Two example queries are given in the brief — **make these bulletproof**:
- "Summarise TCS's latest results"
- "Compare HDFC vs ICICI margins"

---

## Team split

| Person | Hours | Owns |
|---|---|---|
| You (Mahatva) | 16h | Data curation, RAG pipeline, prompts, guardrails, integration, testing, README |
| Radha | 5h | Frontend chat UI + mock stock page, deployment, demo video edit / deck design |

Define the API contract (`/chat` endpoint: request `{query, stock_ticker}`, response `{answer, sources[]}`) in the **first hour** so Radha can build against a stub while you build the real backend — this is what lets 16h and 5h run in parallel instead of blocking each other.

---

## Hour-by-hour

**H0–1 — Lock scope (both)**
- Pick **5 stocks only**: TCS, HDFC Bank, ICICI Bank, Infosys, Reliance (well-covered, easy to source data, makes the "compare X vs Y" demo trivial)
- Decide stack (below), scaffold repo, define API contract
- Radha starts on the stock-page UI shell against the stub contract

**H1–4 — Data curation (you, solo)**
- Per stock, curate: latest quarterly result summary, 2–3 recent filing/announcement summaries, 5–10 recent news snippets
- Save as clean `.md`/`.txt` files, one folder per ticker
- **Mocking data is explicitly allowed** per the brief — don't waste hours building a live scraper
- Use Perplexity Pro here (see tool section) to pull accurate, cited numbers fast

**H4–7 — RAG pipeline core**
- Chunk docs → embed → store in a local vector DB (Chroma is fastest to stand up)
- Retrieval function + strict prompt template: *"Answer only from the provided context. Cite the source file/section for every claim. If no relevant context exists, say so — do not guess."*
- Wire in your generation LLM (see tool section for which one)

**H7–10 — Frontend (Radha, her hours) / Integration prep (you, parallel)**
- Radha: mock "stock detail page" for one featured stock (e.g. TCS) with a chat panel embedded — React + Tailwind, matches her existing stack
- You: build the citation-rendering logic, source-attribution UI contract, start on streaming

**H10–12 — Guardrails + streaming**
- Refuse definitive buy/sell calls; add a disclaimer; graceful "I don't have data on that" fallback
- Streaming response (SSE) if time allows — if not, simulate token-by-token on the frontend, it still satisfies the stretch goal visually

**H12–13 — Integration (both, Radha's final hours)**
- Connect real API to frontend, fix CORS/env issues
- Run the two example queries end-to-end until they're flawless — judges will likely try these almost verbatim

**H13–14 — Testing + README**
- Edge cases: ambiguous ticker, out-of-scope question, no-data question
- README: setup/run instructions, architecture diagram, what's done vs pending — this is directly scored

**H14–15.5 — Demo video + deck**
- Video (3–5 min): problem (20s) → architecture (40s) → live demo showing 2–3 queries **with citations visible** (2 min) → scaling/production notes (40s)
- Deck: problem, solution, architecture, key decisions & tradeoffs, done vs pending, how it scales

**H15.5–16 — Final polish, push, submit**

---

## Suggested stack

- **Backend:** Python + FastAPI
- **Vector store:** Chroma (local, zero cost, fastest setup)
- **Embeddings:** Gemini embedding API (free tier) or sentence-transformers (fully offline, no rate-limit risk)
- **Generation LLM:** Gemini (free API tier) for the deployed app — see below for why
- **Frontend:** React + Tailwind (Radha's stack) — fall back to Streamlit only if a real chat UI proves too slow to wire up in time
- **Data:** curated markdown/JSON per stock (explicitly permitted, don't over-engineer ingestion)

---

## Which AI tool for which job

| Tool | Use it for |
|---|---|
| **Perplexity Pro** | Data-gathering phase (H1–4): fastest way to pull accurate, cited fundamentals/news for your 5 stocks. It's basically a live dry-run of the tool you're building — copy its citation style. |
| **Claude (free)** | Your main coding/architecture partner for the RAG pipeline, prompt design, and guardrail wording (H4–7, H10–12). Strongest at reasoning through multi-step code and safety-conscious prompts. |
| **Gemini Pro** | Two jobs: (1) powers the actual deployed app via its free API tier — no cost, generous limits, so your demo doesn't die on a rate limit; (2) use the chat interface for a final full-codebase review before submission (best long-context handling of the four). |
| **GPT Go** | Backup coding help once Claude's free-tier message cap gets hit mid-build; also solid for fast, polished copy on the video script and deck bullets late in the process. |

**Don't use Claude/GPT/Perplexity/Gemini's paid API for the in-app LLM unless you already have credits** — Gemini's free API tier is the only one of these that won't risk burning out mid-demo.

## To actually crack the PPO
The discussion round (15%) is where AI-assisted code gets exposed if you don't understand it. Be ready to defend, unscripted:
- Why these 5 stocks / why mocked data
- Your chunking + retrieval strategy and why
- Exactly how the guardrails work and what they don't cover
- What breaks at scale (live filings, thousands of tickers) and how you'd fix it

Use the tools to move fast — but every line you can't explain live is a line that costs you the PPO, not earns it.
