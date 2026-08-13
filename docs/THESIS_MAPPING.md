# Thesis ↔ Implementation Mapping

This document maps the technical claims in the UpQuiz thesis (Chapter IV) to the
actual code in this repository, so the running system matches the documentation.

## Technology stack

| Thesis claim | Where in the code |
|---|---|
| React 18 + Vite + TypeScript + Tailwind | `frontend/` (`package.json`, `vite.config.ts`, `tailwind.config.js`) |
| Zustand (client state) | `frontend/src/store.ts`, consumed in `frontend/src/auth.tsx` |
| TanStack React Query (data fetching) | `frontend/src/main.tsx` (provider) + `pages/Materials.tsx`, `ReviewQuestions.tsx`, `Analytics.tsx`, `TeacherDashboard.tsx` |
| React Router v6 | `frontend/src/App.tsx` |
| Go 1.22 + Gin + pgx v5 | `backend/api/` (`go.mod`, `main.go`, `handlers.go`) |
| Node.js + TypeScript AI service | `backend/rag/` |
| Custom JWT (HS256) + HTTP-only cookies + bcrypt | `backend/api/auth.go` (`issueToken`, `setAuthCookie`, `bcrypt`) |
| PostgreSQL 16, database `examdb` | `docker-compose.yml` (`POSTGRES_DB: examdb`), `backend/db/init/` |
| Milvus v2.4.4, 768-dim, IVF_FLAT, cosine | `docker-compose.yml` (image `milvusdb/milvus:v2.4.4`), `backend/rag/src/milvus.ts` |
| Ollama runtime | `docker-compose.yml` (`ollama` service) |
| Models: gemma3:1b, nomic-embed-text | `.env.example`, `docker-compose.yml`, `backend/rag/src/ollama.ts` |
| File storage in Docker volume `/app/uploads` | `docker-compose.yml` (`uploads` volume on `api` + `rag`), `backend/api/documents.go` |
| Document processing: pdf-parse, mammoth, JSZip, Tesseract OCR | `backend/rag/src/extract.ts`, `backend/rag/package.json` |
| Nginx reverse proxy | `nginx/nginx.conf`, `frontend/nginx.conf` |

## Database tables (thesis Table 6)

All tables are defined in `backend/db/init/01_schema.sql`:

`users`, `subjects`, `subject_enrollments`, `uploaded_documents`,
`document_chunks`, `generated_questions`, `exams`, `exam_questions`,
`student_exam_attempts`, `student_answers`, `topic_performance`.

## RAG pipeline (thesis "AI/RAG Framework")

| Thesis step | Implementation |
|---|---|
| Extract text from uploaded file | `backend/rag/src/extract.ts` (`extractText`) |
| 500-word chunks, 50-word overlap | `backend/rag/src/index.ts` (`chunkByWords(text, 500, 50)`) |
| 768-dim embeddings via nomic-embed-text | `backend/rag/src/ollama.ts` (`embed`) |
| Store vectors in Milvus | `backend/rag/src/milvus.ts` (`insertChunks`) |
| Store chunk metadata in PostgreSQL | `document_chunks` insert in `index.ts` `/process` |
| Cosine similarity retrieval | `milvus.ts` (`search`, `metric_type: COSINE`) |
| Generate via gemma3:1b | `index.ts` `/generate` → `chat()` |
| Parse / validate / deduplicate | `extractJSON` + `seen` set in `/generate` |
| Save for teacher review | insert into `generated_questions` (status `pending`) |

## Roles & use cases

| Actor | Capabilities | Code |
|---|---|---|
| Administrator | view users, update roles, deactivate | `GET/PATCH /api/admin/users` (`handlers.go`) |
| Teacher | subjects, enrollment, upload, generate, review, build/publish exams, analytics | `handlers.go`, `documents.go` |
| Student | view assigned exams, take, submit, view score | `startAttempt`, `submitAttempt`, `getAttempt` |

## Scoring (thesis "Question Types and Scoring")

- Objective auto-scoring (MCQ, true/false, fill-in-the-blank): `autoGrade` in
  `backend/api/handlers.go`.
- Essay similarity scoring via embeddings: `POST /grade` in
  `backend/rag/src/index.ts` (cosine of model vs. student answer embeddings).
- Per-topic results written to `topic_performance`; weak-topic detection in
  `subjectAnalytics` (`accuracy < 60%` flagged weak).

## Known deviations / notes for the defense

- **OCR**: Tesseract is wired for image files and image-only PDFs. Full
  page-rendering OCR of scanned multi-page PDFs is bounded by available resources.
- **Matching questions** are generated and stored but graded manually (flagged
  `needs_review`), consistent with the thesis note that essay-type items may need
  review.
- The RAG service connects directly to PostgreSQL (`backend/rag/src/db.ts`) to
  write `document_chunks` and `generated_questions`, matching the thesis statement
  that the AI service stores processed content and generated questions in PostgreSQL.
