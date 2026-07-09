# Logix LLM  🚀

Logix LLM is a **SEBI-compliant, highly constrained AI research assistant** built for the Indian financial sector. It securely analyzes live market data and user portfolios to provide strictly grounded, verifiable research with exact citations — **without giving illegal or unauthorized financial advice**.

> **Why "highly constrained"?** Every AI-generated response passes through a multi-stage guardrail pipeline that validates citations against retrieved context, strips ungrounded speculation, intercepts recommendation-leakage via regex and logical checks, and deterministically injects SEBI-compliant disclaimers — before a single word reaches the user.

---

## ✨ Features

| Mode | Description |
|------|-------------|
| **📈 Stock Research** | Deep, curated analytical research for 5 pre-vetted Indian stocks (TCS, HDFC, ICICI, Infosys, Reliance) backed by exact document citations from filed reports, fundamentals, and news. |
| **🔍 General Research** | An agentic AI (LangChain + Gemini) that fetches live historical data, balance sheets, and news for **any ticker worldwide** via yfinance, and dynamically streams analytical charts directly into the chat. |
| **💼 My Portfolio** | Log your trades, view live-updating P&L, and ask the AI about your holdings. Strict guardrails block the AI from providing direct "Buy/Sell" recommendations while still offering personalized, factual analysis. |
| **🧪 Advance Generative UI** | A sandbox environment utilizing the Thesys C1 SDK for advanced interactive UI component rendering (charts, cards, tables) — intentionally isolated from the main app's compliance guardrails. |

---

## 🏗️ System Architecture

```mermaid
graph TB
    subgraph Frontend["Frontend — React + Vite :5173"]
        UI["App Shell<br/>(Mode Switcher)"]
        SR["StockResearchAssistant"]
        GR["GeneralResearchAssistant"]
        PP["PortfolioPage"]
        GU["AdvanceGenerativeUI"]
    end

    subgraph Backend["Backend — FastAPI + Uvicorn :8000"]
        API["FastAPI Router<br/>(main.py)"]
        
        subgraph Engines["AI Engines"]
            RAG["RAG Engine<br/>(rag_engine.py)"]
            GA["General Agent<br/>(general_agent.py)"]
            PE["Portfolio Engine<br/>(portfolio_engine.py)"]
            TC["Thesys Chat<br/>(thesys_chat.py)"]
        end
        
        subgraph Safety["Compliance Layer"]
            GR_MOD["Guardrails<br/>(guardrails.py)"]
        end
        
        subgraph Data["Data Layer"]
            LI["Live Ingest<br/>(live_ingest.py)"]
            MT["Market Tools<br/>(market_tools.py)"]
            ING["Static Ingest<br/>(ingest.py)"]
        end
    end

    subgraph External["External Services"]
        GEMINI["Google Gemini 2.5 Flash<br/>(Generation + Embedding)"]
        YF["Yahoo Finance<br/>(yfinance)"]
        THESYS["Thesys C1 API<br/>(GenUI)"]
    end

    subgraph Storage["Local Storage"]
        CHROMA["ChromaDB<br/>(Vector Store)"]
        MD["Curated Markdown Docs<br/>(data/)"]
    end

    UI --> SR & GR & PP & GU

    SR -- "POST /chat (SSE)" --> API
    GR -- "POST /chat/general (SSE)" --> API
    PP -- "POST /chat/portfolio (SSE)" --> API
    GU -- "POST /api/chat/thesys (SSE)" --> API
    UI -- "GET /api/prices" --> API

    API --> GR_MOD --> RAG
    API --> GA
    API --> PE
    API --> TC

    RAG --> CHROMA
    RAG --> GEMINI
    GA --> MT --> YF
    GA --> GEMINI
    PE --> LI --> YF
    PE --> CHROMA
    PE --> GEMINI
    TC --> THESYS
    ING --> MD
    ING --> CHROMA
    ING --> GEMINI
    LI --> CHROMA
    LI --> GEMINI
```

---

## 🔄 Request Lifecycle — Stock Research (RAG Pipeline)

This is the core pipeline that powers the Stock Research tab. It demonstrates how a user query flows through retrieval, generation, guardrails, and streaming.

```mermaid
sequenceDiagram
    participant User as 👤 User
    participant FE as React Frontend
    participant API as FastAPI
    participant GR as Guardrails
    participant RAG as RAG Engine
    participant Chroma as ChromaDB
    participant Gemini as Gemini 2.5 Flash

    User->>FE: Types research question
    FE->>API: POST /chat {query, ticker}
    API->>GR: answer_query(query, ticker)
    
    Note over GR: [Step 0] Pre-retrieval<br/>Classify query via regex:<br/>needs_advice_note?<br/>needs_considerations?

    GR->>RAG: retrieve(query, ticker)
    RAG->>RAG: Detect tickers mentioned in query text
    RAG->>Gemini: Embed query (task_type: retrieval_query)
    Gemini-->>RAG: Query embedding vector
    RAG->>Chroma: Similarity search (top-k per ticker)
    Chroma-->>RAG: Ranked chunks + distances

    Note over GR: [Step 1] Post-retrieval filter<br/>Drop chunks with distance ><br/>MAX_RELEVANT_DISTANCE (0.75)

    alt No relevant chunks survive
        GR-->>API: Graceful refusal (no generation)
    else Relevant chunks found
        GR->>RAG: generate(query, filtered_chunks)
        RAG->>Gemini: Prompt with context + strict citation rules
        Gemini-->>RAG: Markdown response (Answer / Considerations / Note)
        RAG-->>GR: Raw generated answer

        Note over GR: [Step 2] Post-generation validation<br/>4a. Citation-existence check<br/>4b. Considerations grounding check<br/>4c. Recommendation-leakage scan<br/>4d. Disclaimer injection

        GR-->>API: Validated answer + sources + flags
    end

    API->>FE: SSE stream (word-by-word tokens)
    FE->>User: Typewriter-effect rendering
    API->>FE: SSE event: sources (citation chips)
    FE->>User: Render footnotes / citation badges
```

---

## 🔄 Request Lifecycle — General Research (Agentic Pipeline)

The General Research tab uses a **LangChain tool-calling agent** instead of RAG, enabling it to answer questions about any publicly traded stock worldwide.

```mermaid
sequenceDiagram
    participant User as 👤 User
    participant FE as React Frontend
    participant API as FastAPI
    participant Agent as LangChain Agent
    participant Tools as Market Tools
    participant YF as Yahoo Finance
    participant Gemini as Gemini 2.5 Flash

    User->>FE: "Compare TCS and Infosys revenue"
    FE->>API: POST /chat/general {query}
    API->>Agent: answer_general_query(query)

    loop Agent reasoning loop
        Agent->>Gemini: Decide which tool(s) to call
        Gemini-->>Agent: Tool call decision

        alt get_stock_price
            Agent->>Tools: fetch_price(ticker)
            Tools->>YF: yfinance API call
            YF-->>Tools: Current price data
        else get_historical_stock_price
            Agent->>Tools: fetch_historical_prices(ticker, start, end)
            Tools->>YF: yfinance historical data
            YF-->>Tools: Daily OHLCV series
        else get_balance_sheet
            Agent->>Tools: fetch_balance_sheet(ticker)
            Tools->>YF: yfinance financials
            YF-->>Tools: Balance sheet line items
        else get_stock_news
            Agent->>Tools: fetch_news(ticker)
            Tools->>YF: yfinance news feed
            YF-->>Tools: Recent headlines
        end

        Agent->>Gemini: Feed tool results back
    end

    Gemini-->>Agent: Final markdown answer + chart_data
    
    Note over Agent: Apply section parsing<br/>(split_sections / rebuild_markdown)<br/>Same format as RAG pipeline

    Agent-->>API: {answer, sources, chart_data}
    API->>FE: SSE stream: tokens → sources → chart_data
    FE->>User: Render answer + interactive Recharts chart
```

---

## 🔄 Request Lifecycle — Portfolio Analysis

The Portfolio tab combines **live market data**, **curated RAG context**, and **user-provided position data** to deliver personalized (but never advisory) analysis.

```mermaid
sequenceDiagram
    participant User as 👤 User
    participant FE as React Frontend
    participant API as FastAPI
    participant PE as Portfolio Engine
    participant LI as Live Ingest
    participant YF as Yahoo Finance
    participant Chroma as ChromaDB
    participant Gemini as Gemini 2.5 Flash

    User->>FE: Asks about portfolio holdings
    FE->>API: POST /chat/portfolio {query, portfolio}
    API->>PE: answer_portfolio_query(query, portfolio)

    loop For each ticker in portfolio
        PE->>LI: Is ticker in ChromaDB?
        alt Ticker not in DB
            LI->>YF: Fetch live data (price, financials, news)
            YF-->>LI: Raw market data
            LI->>LI: Convert to markdown chunks
            LI->>Gemini: Embed chunks
            Gemini-->>LI: Embedding vectors
            LI->>Chroma: Upsert chunks (idempotent)
        end
        PE->>YF: Fetch current price for P&L calc
        YF-->>PE: Live price
    end

    PE->>PE: Calculate P&L, gain/loss per position
    PE->>Chroma: Retrieve relevant context chunks
    Chroma-->>PE: Context for each holding
    PE->>Gemini: Generate with portfolio context + strict rules
    Gemini-->>PE: Personalized analysis

    Note over PE: Post-generation checks:<br/>• Position number validation<br/>• Portfolio-specific leakage scan<br/>• Citation grounding check<br/>• Disclaimer injection

    PE-->>API: {answer, sources, guardrail_flags}
    API->>FE: SSE stream: tokens → sources → flags
    FE->>User: Render personalized analysis
```

---

## 🛡️ Guardrails Architecture

MoneyLogix implements a **4-stage compliance pipeline** to ensure no AI-generated response crosses the line from information into financial advice.

```mermaid
graph LR
    Q["User Query"] --> S0

    subgraph Pre-Retrieval
        S0["Stage 0: Query Classification<br/>━━━━━━━━━━━━━━━━━━━━━━<br/>• needs_advice_note? (regex)<br/>• needs_considerations? (regex)"]
    end

    S0 --> S1

    subgraph Post-Retrieval
        S1["Stage 1: Relevance Filtering<br/>━━━━━━━━━━━━━━━━━━━━━━<br/>• Drop chunks with cosine<br/>  distance > 0.75<br/>• If none survive → refuse<br/>  gracefully, skip generation"]
    end

    S1 --> GEN["Gemini Generation<br/>(Answer / Considerations / Note)"]
    GEN --> S2

    subgraph Post-Generation
        S2["Stage 2: Output Validation<br/>━━━━━━━━━━━━━━━━━━━━━━<br/>2a. Citation-existence check<br/>2b. Considerations grounding<br/>     (drop if ungrounded)<br/>2c. Recommendation-leakage<br/>     regex scan<br/>2d. Disclaimer injection"]
    end

    S2 --> OUT["✅ Validated Response<br/>+ Sources + Flags"]

    style Pre-Retrieval fill:#E8F5E9,stroke:#2E7D32
    style Post-Retrieval fill:#FFF3E0,stroke:#E65100
    style Post-Generation fill:#FFEBEE,stroke:#C62828
```

### What Each Check Catches

| Check | What It Catches | Action Taken |
|-------|----------------|--------------|
| **Query Classification** | Advice-seeking queries ("should I buy?", "is it a good investment?") | Flags for post-gen disclaimer; enables Considerations section only when appropriate |
| **Relevance Filtering** | Queries about stocks/topics not in the knowledge base | Graceful refusal instead of hallucinated answers |
| **Citation Existence** | Generated text that references sources not in retrieved chunks | Flags for observability |
| **Considerations Grounding** | Speculative "Considerations" not backed by any retrieved source | Entire section is **dropped** (not just flagged) |
| **Recommendation Leakage** | Phrases like "buy", "sell", "hold", "book profit", "good entry point", "average down" | Flagged; in portfolio mode, extended regex catches softer phrasings |
| **Disclaimer Injection** | All advice-adjacent responses | Deterministic SEBI-compliant disclaimer appended (randomly selected from variants) |

---

## 📁 Project Structure

```
Logix LLM/
├── main.py                  # FastAPI app — routes, SSE streaming, CORS, static mount
├── rag_engine.py            # Core RAG pipeline — retrieval + grounded generation
├── guardrails.py            # Compliance layer — wraps rag_engine with 4-stage validation
├── general_agent.py         # LangChain tool-calling agent for General Research mode
├── portfolio_engine.py      # Portfolio-aware engine — P&L calc + personalized analysis
├── market_tools.py          # yfinance wrappers — @tool decorated + plain fetch_* functions
├── live_ingest.py           # On-demand yfinance → ChromaDB ingestion for any ticker
├── ingest.py                # Static ingestion — curated markdown docs → ChromaDB
├── thesys_chat.py           # Thesys C1 GenUI sandbox — isolated from guardrails
├── requirements.txt         # Python dependencies
├── .env                     # API keys (GEMINI_API_KEY, THESYS_API_KEY) — gitignored
│
├── data/                    # Curated research documents (markdown)
│   ├── TCS/                 # tcs_fundamentals.md, tcs_filings.md, tcs_news.md
│   ├── HDFC/
│   ├── ICICI/
│   ├── INFOSYS/
│   └── RELIANCE/
│
├── chroma_db/               # ChromaDB persistent vector store
│
└── frontend/                # React + Vite frontend
    ├── index.html
    ├── package.json
    ├── vite.config.js       # Dev proxy: /chat, /api → localhost:8000
    ├── tailwind.config.js
    └── src/
        ├── main.jsx         # React entry point
        ├── App.jsx          # Mode switcher (Stock / General / Portfolio / GenUI)
        └── components/
            ├── StockResearchAssistant.jsx    # Curated stock research chat UI
            ├── GeneralResearchAssistant.jsx  # Agentic research chat + live charts
            ├── PortfolioPage.jsx            # Portfolio manager + P&L + chat
            └── AdvanceGenerativeUI.jsx      # Thesys C1 sandbox
```

---

## 🔧 Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 18, Vite 5, Tailwind CSS | Reactive UI with SSE streaming, live charts (Recharts) |
| **Backend** | Python, FastAPI, Uvicorn | Async API server with Server-Sent Events (SSE) |
| **AI Generation** | Google Gemini 2.5 Flash | Reasoning, tool-calling agents, response generation |
| **AI Embeddings** | Gemini Embedding-001 | Document vectorization for semantic search |
| **Vector Database** | ChromaDB (local, persistent) | Similarity search over embedded document chunks |
| **Live Data** | Yahoo Finance (yfinance) | Real-time prices, historical OHLCV, financials, news |
| **Agentic Framework** | LangChain + LangGraph | Tool-calling agent orchestration for General Research |
| **Generative UI** | Thesys C1 SDK | Interactive UI component rendering (charts, cards, tables) |

---

## 🛠️ Local Setup & Installation

Follow these steps to get the project running on your local machine.

### 1. Clone the Repository
```bash
git clone https://github.com/Mahatva777/Logix-LLM.git
cd "Logix LLM"
```

### 2. Backend Setup (FastAPI)
The backend is built with Python and FastAPI. It requires **Python 3.10+**.

1. **Create a virtual environment:**
   ```bash
   python -m venv .venv
   ```

2. **Activate the virtual environment:**
   - On macOS/Linux:
     ```bash
     source .venv/bin/activate
     ```
   - On Windows:
     ```bash
     .venv\Scripts\activate
     ```

3. **Install backend dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Set up Environment Variables:**
   Create a `.env` file in the root directory (where `main.py` is located) and add your API keys:
   ```env
   GEMINI_API_KEY="your_gemini_api_key_here"
   THESYS_API_KEY="your_thesys_api_key_here"
   ```

5. **Ingest the curated research documents** (one-time setup):
   ```bash
   python ingest.py --data-dir data --persist-dir chroma_db
   ```

6. **Start the Backend Server:**
   ```bash
   uvicorn main:app --reload --port 8000
   ```
   > The backend will now be running on `http://127.0.0.1:8000`.

### 3. Frontend Setup (React + Vite)
The frontend is built with React and Vite. It requires **Node.js 18+**.

1. **Navigate to the frontend directory** (open a **new terminal**):
   ```bash
   cd frontend
   ```

2. **Install frontend dependencies:**
   ```bash
   npm install
   ```

3. **Start the Frontend Development Server:**
   ```bash
   npm run dev
   ```
   > The frontend will start on `http://localhost:5173/`.

### 4. Running the Application
Once both servers are running:
1. Open your browser and go to **`http://localhost:5173/`**.
2. The Vite proxy in `vite.config.js` is automatically configured to route API calls (`/chat`, `/api`) to your Python backend running on port `8000`.

> **Production mode:** Run `npm run build` in `frontend/` to produce a static bundle in `frontend/dist/`. The FastAPI app automatically serves this directory, making `/chat` same-origin — no proxy or CORS needed.

---

## 🔌 API Endpoints

| Method | Endpoint | Description | Request Body |
|--------|----------|-------------|--------------|
| `POST` | `/chat` | Curated stock research (RAG + guardrails) | `{query, ticker, portfolio}` |
| `POST` | `/chat/general` | Agentic research for any ticker | `{query}` |
| `POST` | `/chat/portfolio` | Portfolio-aware personalized analysis | `{query, portfolio: [{ticker, buy_date, buy_price, quantity}]}` |
| `POST` | `/api/chat/thesys` | Thesys C1 GenUI sandbox | C1Chat SDK format |
| `POST` | `/api/ingest/ticker` | Trigger live yfinance → ChromaDB ingest | `{ticker}` |
| `GET`  | `/api/prices` | Live INR quotes for 5 curated stocks (15s cache) | — |

All streaming endpoints return **Server-Sent Events (SSE)** with event types: `token`, `sources`, `chart_data`, `guardrail_flags`, `error`.

---

## 📜 License

This project was built for hackathon/educational purposes. Please ensure compliance with applicable financial regulations (SEBI guidelines in India) before any production deployment.
