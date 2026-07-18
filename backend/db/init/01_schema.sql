-- UpQuiz (examdb) schema — aligned to thesis Chapter IV "Database Tables"
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------- users ----------
CREATE TYPE user_role AS ENUM ('student', 'educator', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'pending');

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          user_role NOT NULL DEFAULT 'student',
    identifier    TEXT,                        -- student ID or employee number
    avatar_url    TEXT,                        -- profile picture served from /api/avatars
    status        user_status NOT NULL DEFAULT 'active',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- subjects ----------
CREATE TYPE subject_status AS ENUM ('active', 'archived');

CREATE TABLE subjects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    department  TEXT,
    description TEXT,
    educator_id UUID REFERENCES users(id) ON DELETE SET NULL,
    status      subject_status NOT NULL DEFAULT 'active',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- subject_enrollments ----------
CREATE TABLE subject_enrollments (
    subject_id  UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    student_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subject_id, student_id)
);

-- ---------- uploaded_documents (learning material metadata) ----------
CREATE TYPE document_status AS ENUM ('uploaded', 'processing', 'ready', 'error');

CREATE TABLE uploaded_documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id  UUID REFERENCES subjects(id) ON DELETE CASCADE,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    filename    TEXT NOT NULL,
    file_type   TEXT,
    module_label TEXT NOT NULL DEFAULT 'Module 1',
    file_path   TEXT NOT NULL,               -- path within the shared uploads volume
    size_bytes  BIGINT DEFAULT 0,
    status      document_status NOT NULL DEFAULT 'uploaded',
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- document_chunks (extracted + chunked text) ----------
CREATE TABLE document_chunks (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  UUID NOT NULL REFERENCES uploaded_documents(id) ON DELETE CASCADE,
    subject_id   UUID REFERENCES subjects(id) ON DELETE CASCADE,
    chunk_index  INT NOT NULL,
    content      TEXT NOT NULL,
    milvus_id    BIGINT,                      -- primary key of the vector in Milvus
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- generated_questions (AI output staged for educator review) ----------
CREATE TYPE question_type AS ENUM ('mcq', 'true_false', 'fill_blank', 'essay', 'matching');
CREATE TYPE difficulty AS ENUM ('easy', 'medium', 'hard');
CREATE TYPE generated_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE generated_questions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id  UUID REFERENCES subjects(id) ON DELETE CASCADE,
    document_id UUID REFERENCES uploaded_documents(id) ON DELETE SET NULL,
    type        question_type NOT NULL,
    difficulty  difficulty NOT NULL DEFAULT 'medium',
    points      INT NOT NULL DEFAULT 1,
    prompt      TEXT NOT NULL,
    options     JSONB,
    answer      JSONB,
    topic       TEXT,
    image_url   TEXT,
    source_ref  TEXT,                         -- grounding quote from retrieved chunk
    status      generated_status NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- exams ----------
CREATE TYPE exam_status AS ENUM ('draft', 'published', 'closed');

CREATE TABLE exams (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id    UUID REFERENCES subjects(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    duration_min  INT NOT NULL DEFAULT 60,
    total_points  INT NOT NULL DEFAULT 0,
    exam_mode     TEXT NOT NULL DEFAULT 'take_home' CHECK (exam_mode IN ('take_home', 'live')),
    access_code   TEXT,
    live_state    TEXT NOT NULL DEFAULT 'waiting' CHECK (live_state IN ('waiting', 'started', 'ended')),
    live_started_at TIMESTAMPTZ,
    starts_at     TIMESTAMPTZ,
    status        exam_status NOT NULL DEFAULT 'draft',
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- exam_questions (approved questions assigned to an exam) ----------
CREATE TABLE exam_questions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id     UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    type        question_type NOT NULL,
    difficulty  difficulty NOT NULL DEFAULT 'medium',
    points      INT NOT NULL DEFAULT 1,
    prompt      TEXT NOT NULL,
    options     JSONB,
    answer      JSONB,
    topic       TEXT,
    image_url   TEXT,
    source_ref  TEXT,
    position    INT NOT NULL DEFAULT 0
);

-- ---------- student_exam_attempts ----------
CREATE TYPE attempt_status AS ENUM ('in_progress', 'completed', 'needs_review');

CREATE TABLE student_exam_attempts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    exam_id        UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    student_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status         attempt_status NOT NULL DEFAULT 'in_progress',
    score          INT,
    total_points   INT,
    answered_count INT NOT NULL DEFAULT 0,       -- live progress reported via heartbeat
    last_seen_at   TIMESTAMPTZ,                  -- last heartbeat while taking the exam
    focused        BOOLEAN NOT NULL DEFAULT TRUE, -- exam tab focus (live proctoring signal)
    joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at     TIMESTAMPTZ,
    submitted_at   TIMESTAMPTZ,
    UNIQUE (exam_id, student_id)
);

-- ---------- student_answers ----------
CREATE TABLE student_answers (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id     UUID NOT NULL REFERENCES student_exam_attempts(id) ON DELETE CASCADE,
    question_id    UUID NOT NULL REFERENCES exam_questions(id) ON DELETE CASCADE,
    response       JSONB,
    awarded_points INT,
    is_correct     BOOLEAN,
    feedback       TEXT,
    UNIQUE (attempt_id, question_id)
);

-- ---------- topic_performance (analytics) ----------
CREATE TABLE topic_performance (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id  UUID NOT NULL REFERENCES student_exam_attempts(id) ON DELETE CASCADE,
    subject_id  UUID REFERENCES subjects(id) ON DELETE CASCADE,
    topic       TEXT NOT NULL,
    correct     INT NOT NULL DEFAULT 0,
    total       INT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subjects_educator   ON subjects(educator_id);
CREATE INDEX idx_enrollments_student ON subject_enrollments(student_id);
CREATE INDEX idx_documents_subject   ON uploaded_documents(subject_id);
CREATE INDEX idx_documents_module    ON uploaded_documents(subject_id, module_label);
CREATE INDEX idx_chunks_document     ON document_chunks(document_id);
CREATE INDEX idx_genq_subject_status ON generated_questions(subject_id, status);
CREATE INDEX idx_exams_subject       ON exams(subject_id);
CREATE INDEX idx_examq_exam          ON exam_questions(exam_id);
CREATE INDEX idx_attempts_student    ON student_exam_attempts(student_id);
CREATE INDEX idx_topicperf_subject   ON topic_performance(subject_id);

-- ---------- generation_jobs (async AI generation tracking) ----------
CREATE TABLE generation_jobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id  UUID REFERENCES subjects(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'running',  -- running | done | error
    requested   INT  NOT NULL DEFAULT 0,
    generated   INT  NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ
);
