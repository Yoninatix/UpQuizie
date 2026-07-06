// Cookie-based auth: the JWT lives in an HTTP-only cookie set by the API,
// so the browser sends it automatically with credentials: "include".

export interface ApiError extends Error {
  status?: number;
  body?: any;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isForm ? {} : { "Content-Type": "application/json" }),
    ...(options.headers as Record<string, string>),
  };

  const res = await fetch(`/api${path}`, { ...options, headers, credentials: "include" });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let body: any = null;
    try {
      body = await res.json();
      if (body.error) msg = body.error;
    } catch {
      /* ignore */
    }
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(p: string) => request<T>(p),
  post: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) =>
    request<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(p: string) => request<T>(p, { method: "DELETE" }),
  upload: <T>(p: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<T>(p, { method: "POST", body: fd });
  },
};

// ---------- types ----------
export interface User {
  id: string;
  email: string;
  full_name: string;
  role: "student" | "educator" | "admin";
}
export interface Subject {
  id: string;
  code: string;
  name: string;
  department?: string;
  status: string;
  educator?: string;
  students: number;
  active_exams: number;
}
export interface Exam {
  id: string;
  title: string;
  duration_min: number;
  total_points: number;
  status: string;
  subject?: string;
  subject_id?: string;
  exam_mode: "take_home" | "live";
  live_state: "waiting" | "started" | "ended";
  access_code?: string | null;
  live_started_at?: string | null;
  due_at?: string | null;
}
export interface Question {
  id: string;
  type: string;
  difficulty: string;
  points: number;
  prompt: string;
  options: any;
  answer?: any;
  topic?: string;
  source_ref?: string;
  status?: string;
  position?: number;
}
export interface MonitorStudent {
  student_id: string;
  name: string;
  identifier: string;
  attempt_id: string | null;
  status: "not_started" | "waiting" | "in_progress" | "completed" | "needs_review";
  answered_count: number;
  question_count: number;
  score: number | null;
  total_points: number | null;
  joined_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  last_seen_at: string | null;
  focused: boolean | null;
}
export interface ExamMonitor {
  exam: { id: string; title: string; status: string; duration_min: number; total_points: number; question_count: number; exam_mode: "take_home" | "live"; live_state: "waiting" | "started" | "ended"; access_code: string | null; live_started_at: string | null };
  summary: { enrolled: number; not_started: number; waiting: number; in_progress: number; submitted: number };
  students: MonitorStudent[];
  now: string;
}
export interface DocumentMeta {
  id: string;
  filename: string;
  file_type?: string;
  size_bytes: number;
  status: string;
  error?: string;
}
