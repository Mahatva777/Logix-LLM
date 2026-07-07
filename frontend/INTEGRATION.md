# Wiring the React UI into the FastAPI backend

## What changed vs. what you already have

| File | Status |
|---|---|
| `guardrails.py` | **unchanged** — drop in as-is |
| `rag_engine.py` | **unchanged** — drop in as-is |
| `main.py` | **replaced** — same `/chat` pipeline, plus CORS middleware and a `StaticFiles` mount for the built frontend |
| `frontend/` | **new** — Vite + React + Tailwind project containing the UI |

Your existing `chroma_db/`, `ingest.py`, and `.env`/API key setup are untouched — this only adds a frontend and adjusts `main.py`'s bottom half.

## 1. Directory layout

Put everything at the same level like this:

```
your-project/
├── main.py                # replace with the one below
├── guardrails.py          # unchanged
├── rag_engine.py           # unchanged
├── ingest.py               # unchanged (yours)
├── chroma_db/              # unchanged (yours)
├── requirements.txt        # yours (fastapi, uvicorn, chromadb, google-genai, etc.)
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── .gitignore
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── index.css
        └── components/
            └── StockResearchAssistant.jsx
```

## 2. Backend setup (one-time)

No new Python packages are required beyond what you already have (`fastapi`, `uvicorn`) — `CORSMiddleware` and `StaticFiles` both ship with FastAPI/Starlette.

Make sure your `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) is set, same as before:

```bash
export GEMINI_API_KEY=your-key-here
```

## 3. Frontend setup (one-time)

```bash
cd frontend
npm install
```

## 4. Running in development (two terminals)

**Terminal 1 — backend:**
```bash
uvicorn main:app --reload --port 8000
```

**Terminal 2 — frontend:**
```bash
cd frontend
npm run dev
```

Open **http://localhost:5173**. Vite's dev proxy (already configured in `vite.config.js`) forwards the component's `fetch("/chat")` calls to `http://127.0.0.1:8000/chat`, so there's nothing else to wire up. You should see the TCS page with the fundamentals panel and the chat working end-to-end against your real RAG pipeline.

If you see a "demo data" indicator in the chat header instead of "live", it means the fetch to `/chat` failed — check Terminal 1 for errors (missing API key, Chroma persist dir not found, etc.) and check the browser console/network tab.

## 5. Running in production (single origin, no CORS needed)

```bash
cd frontend
npm run build        # outputs frontend/dist/
cd ..
uvicorn main:app --host 0.0.0.0 --port 8000
```

`main.py` mounts `frontend/dist` at `/` once it exists, so the whole app — UI and API — is served from `http://<host>:8000`. The frontend's `fetch("/chat")` now hits the same origin directly; the CORS middleware becomes a no-op but is harmless to leave in.

## 6. Extending to the other 4 stocks

Right now `StockResearchAssistant.jsx` hardcodes `STOCK = { ticker: "TCS", ... }` and the fundamentals array, per the brief's "5-stock hackathon scope." To make it generic:

1. Move `STOCK` and `FUNDAMENTALS` into a small lookup keyed by ticker (`HDFC`, `ICICI`, `INFY`, `RELIANCE`, `TCS`).
2. Pass `ticker` as a prop from `App.jsx` (e.g. via `react-router` routes like `/stocks/:ticker`, reading `useParams()`).
3. Everything else — the chat panel, SSE parsing, citation rendering — already takes `ticker` generically (it's already sent in the `POST /chat` body), so no changes needed there.

This is intentionally left as a manual step rather than guessed at, since it depends on whether you're adding real routing or keeping one page per deploy for the demo.
