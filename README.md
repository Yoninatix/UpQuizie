# UpQuizie

An AI-assisted academic examination platform built from the UpQuiz design.
Educators upload learning materials, generate exam questions **grounded in those
materials** via Retrieval-Augmented Generation (RAG), administer exams, and
review results. Students take auto-graded exams and see their performance.

## Architecture

```
                    ┌──────────────┐
   Browser  ─────►  │   Nginx :8080 │  (reverse proxy)
                    └──────┬───────┘
              /            │            /api
        ┌─────▼─────┐      └──────►┌────▼────────┐
        │  web      │              │  api (Go)   │
        │ React+TS  │              │  Gin :8000  │
        │ (nginx)   │              └──┬───────┬──┘
        └───────────┘                 │       │
                              Postgres │       │ HTTP
                              :5432 ◄──┘       ▼
                                          ┌─────────────┐
                                          │ rag (TS)    │
                                          │ Express:7000│
                                          └──┬───────┬──┘
                                     Ollama  │       │  Milvus
                                     :11434 ◄┘       └► :19530
```

| Service    | Folder           | Stack                              | Role                                           |
|------------|------------------|------------------------------------|------------------------------------------------|
| `web`      | `frontend/`      | React + TypeScript + Vite + Tailwind | UI (login, dashboards, exam taking, results) |
| `api`      | `backend/api/`   | Go + Gin                           | Auth (JWT), subjects, exams, questions, attempts |
| `rag`      | `backend/rag/`   | TypeScript + Express               | Embed/index materials, generate & grade questions |
| `postgres` | `backend/db/`    | PostgreSQL 16                      | Relational data                                |
| `ollama`   | —                | Ollama                             | LLM (`gemma:2b`) + embeddings (`nomic-embed-text`) |
| `milvus`   | —                | Milvus 2.4 (+ etcd, minio)         | Vector store for document chunks               |
| `nginx`    | `nginx/`         | Nginx                              | Reverse proxy, single entry point on :8080     |

## Project layout

```
UpQuizie/
├── docker-compose.yml      # orchestrates all services
├── nginx/                  # reverse proxy config
├── frontend/               # React + TypeScript app (Vite + Tailwind)
└── backend/
    ├── api/                # Go + Gin REST API
    ├── rag/                # TypeScript + Express RAG service
    └── db/                 # PostgreSQL schema + seed
```

## Quick start

```bash
cp .env.example .env            # optional: set JWT_SECRET, model names

docker compose up --build       # builds & starts everything
```

Then pull the Ollama models once (first run only):

```bash
docker exec -it upquizie-ollama ollama pull nomic-embed-text
docker exec -it upquizie-ollama ollama pull gemma3:1b
```

Open **http://localhost:8080**.

### Demo accounts (password: `password123`)

| Email                   | Role     |
|-------------------------|----------|
| `admin@university.edu`  | admin    |
| `grecia@university.edu` | educator |
| `alex@university.edu`   | student  |

## The RAG pipeline (core feature, aligned to thesis Chapter IV)

1. **Upload** — Educator uploads a learning material on the **Learning Materials**
   page (`POST /api/subjects/:id/documents`, multipart). The Go API saves the file
   to the shared `/app/uploads` volume and records metadata in `uploaded_documents`.
2. **Process** — The API calls the RAG service `/process`, which extracts text
   (pdf-parse / mammoth / JSZip / Tesseract OCR), splits it into **500-word chunks
   with 50-word overlap**, embeds each with `nomic-embed-text` (768-dim), stores the
   vectors in **Milvus** (IVF_FLAT, cosine) and the chunk text in `document_chunks`.
3. **Retrieve + generate** — On the **Generate** page the educator picks a subject,
   optional topic, and a question distribution. The RAG service embeds that query
   once (with a bounded in-memory cache for repeats), performs a cosine top-k search
   in Milvus, augments one batched **gemma3:1b** prompt with the retrieved chunks,
   and generates strict JSON questions. Deterministic guards reject any question
   whose citation is not an exact uploaded-document excerpt, whose choices are not
   found in retrieved chunks, or whose correct answer is absent from its evidence.
   Valid questions are linked to their source document and written to
   `generated_questions`; invalid model output uses a mechanically grounded document
   cloze fallback rather than general knowledge or placeholders.
4. **Review** — On the **Review Questions** page the educator approves/rejects
   pending questions and builds an exam from the approved ones (`exam_questions`).
5. **Administer** — Students take published exams; objective items (MCQ /
   true-false / fill-blank) are auto-scored, per-topic results are written to
   `topic_performance`, and the educator's **Analytics** page surfaces weak topics.

## Local development (without Docker)

```bash
# API
cd backend/api && go run .                  # needs a local Postgres + DATABASE_URL

# RAG
cd backend/rag && npm install && npm run dev # needs MILVUS_ADDRESS + OLLAMA_URL

# Web
cd frontend && npm install && npm run dev    # http://localhost:5173 (proxies /api → :8000)
```

## API surface (selected)

```
POST /api/auth/register        POST /api/auth/login        GET  /api/me
GET  /api/subjects             POST /api/subjects
GET  /api/subjects/:id/materials   POST /api/subjects/:id/materials
GET  /api/exams                POST /api/exams             GET  /api/exams/:id
GET  /api/exams/:id/questions  POST /api/exams/:id/questions
POST /api/exams/:id/generate   (→ RAG service)
POST /api/exams/:id/attempts   POST /api/attempts/:id/submit   GET /api/attempts/:id
GET  /api/admin/users          (admin only)
```

## Notes & known gaps

- This is a complete, runnable **vertical-slice scaffold**: auth, subjects,
  materials, RAG generation, exam taking, and auto-grading work end to end.
  Several Stitch screens (live proctoring, detailed analytics, score-override
  review, enrollment management) are represented in the design and data model
  but not yet wired into dedicated React pages.
- The first model pull and the first Milvus collection load take a few minutes.
- `gemma:2b` is the default LLM for speed; swap `LLM_MODEL` in `.env` for a
  larger model if you have the resources. If you change the embedding model,
  update `EMBED_DIM` to match (nomic-embed-text = 768).
- Seeded passwords use pgcrypto bcrypt; replace `JWT_SECRET` before any real use.
```
