-- Live exam lobby/session support. Safe to run against an existing database.
ALTER TABLE exams ADD COLUMN IF NOT EXISTS exam_mode TEXT NOT NULL DEFAULT 'take_home';
ALTER TABLE exams ADD COLUMN IF NOT EXISTS live_state TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE exams ADD COLUMN IF NOT EXISTS live_started_at TIMESTAMPTZ;
ALTER TABLE student_exam_attempts ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE student_exam_attempts ADD COLUMN IF NOT EXISTS answered_count INT NOT NULL DEFAULT 0;
ALTER TABLE student_exam_attempts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE student_exam_attempts ADD COLUMN IF NOT EXISTS focused BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE student_exam_attempts ALTER COLUMN started_at DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE exams ADD CONSTRAINT exams_mode_check CHECK (exam_mode IN ('take_home', 'live'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE exams ADD CONSTRAINT exams_live_state_check CHECK (live_state IN ('waiting', 'started', 'ended'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
