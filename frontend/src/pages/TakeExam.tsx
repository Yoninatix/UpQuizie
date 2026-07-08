import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Layout, { Icon } from "../components/Layout";
import { api, ApiError, Exam, Question } from "../api";

export default function TakeExam() {
  const { id } = useParams();
  const nav = useNavigate();
  const [exam, setExam] = useState<Exam | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [attemptId, setAttemptId] = useState("");
  const [responses, setResponses] = useState<Record<string, any>>({});
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [startError, setStartError] = useState("");

  // Access gating
  const [needCode, setNeedCode] = useState<boolean | null>(null);
  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState("");
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.get<{ requires_code: boolean; exam_mode: "take_home" | "live"; live_state: string }>(`/exams/${id}/access`)
      .then((r) => { setNeedCode(r.requires_code); if (!r.requires_code) begin(); })
      .catch(() => { setNeedCode(false); begin(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Each exam may only be taken once. startAttempt either begins a fresh
  // attempt, resumes the caller's own in-progress one (page refresh), or
  // rejects with 409 + attempt_id when the student has already submitted —
  // in that case we send them straight to their results instead of retaking it.
  async function begin(entryCode = "", polling = false) {
    if (!id || (started && !polling)) return;
    if (!polling) setStarted(true);
    try {
      const a = await api.post<{ attempt_id: string; started_at?: string | null; ends_at?: string | null; waiting?: boolean }>(`/exams/${id}/attempts`, { code: entryCode });
      const ex = exam || await api.get<Exam>(`/exams/${id}`);
      setExam(ex);
      setAttemptId(a.attempt_id);
      if (a.waiting) {
        setWaiting(true);
        return;
      }
      setWaiting(false);
      const durationSec = (ex.duration_min || 60) * 60;
      const remaining = ex.exam_mode === "live" && a.ends_at
        ? Math.floor((new Date(a.ends_at).getTime() - Date.now()) / 1000)
        : durationSec - (a.started_at ? Math.floor((Date.now() - new Date(a.started_at).getTime()) / 1000) : 0);
      setSecondsLeft(Math.max(0, remaining));
      setQuestions(await api.get<Question[]>(`/exams/${id}/questions`));
    } catch (e) {
      const err = e as ApiError;
      if (err.body?.attempt_id) {
        nav(`/attempts/${err.body.attempt_id}/results`, { replace: true });
        return;
      }
      setStartError(err.message || "Could not start this exam.");
    }
  }

  async function verifyCode() {
    setCodeErr("");
    try {
      await api.post(`/exams/${id}/verify`, { code });
      setNeedCode(false);
      begin(code);
    } catch (e: any) {
      setCodeErr(e.message || "Invalid code");
    }
  }

  // A live-exam lobby polls until the teacher releases the class.
  useEffect(() => {
    if (!waiting || !id) return;
    const poll = setInterval(() => begin(code, true), 2000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, id, code]);

  // Timer
  useEffect(() => {
    if (secondsLeft == null) return;
    if (secondsLeft <= 0) { submit(); return; }
    const t = setTimeout(() => setSecondsLeft((s) => (s == null ? s : s - 1)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  const setResp = (qid: string, value: any) => setResponses((r) => ({ ...r, [qid]: value }));

  // Count questions the student has actually answered (drives the live monitor).
  const answeredCount = questions.reduce((n, qq) => {
    const r = responses[qq.id];
    const answered =
      r != null && (r.index != null || r.value != null || (typeof r.text === "string" && r.text.trim() !== ""));
    return answered ? n + 1 : n;
  }, 0);
  const answeredRef = useRef(0);
  answeredRef.current = answeredCount;

  // Heartbeat: report progress + tab focus so educators can monitor the session.
  useEffect(() => {
    if (!attemptId) return;
    let focused = typeof document !== "undefined" ? !document.hidden : true;
    const send = () =>
      api.post(`/attempts/${attemptId}/heartbeat`, { answered_count: answeredRef.current, focused }).catch(() => {});
    const onVis = () => { focused = !document.hidden; send(); };
    const onFocus = () => { focused = true; send(); };
    const onBlur = () => { focused = false; send(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    send();
    const iv = setInterval(send, 10000);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  async function submit() {
    if (!attemptId || busy) return;
    setBusy(true);
    try {
      const answers = questions.map((q) => ({ question_id: q.id, response: responses[q.id] ?? {} }));
      await api.post(`/attempts/${attemptId}/submit`, { answers });
      nav(`/attempts/${attemptId}/results`);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) { nav(`/attempts/${attemptId}/results`, { replace: true }); return; }
      alert(err.message);
    } finally { setBusy(false); }
  }

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // Access code modal
  if (needCode) {
    return (
      <Layout title="Verify Access Code">
        <div className="max-w-md mx-auto bg-surface-container-lowest border border-outline-variant rounded-xl p-8 mt-10 text-center">
          <div className="w-16 h-16 mx-auto bg-primary-container text-on-primary-container rounded-full flex items-center justify-center mb-4">
            <Icon name="lock" className="text-[32px]" />
          </div>
          <h2 className="font-headline text-2xl text-primary mb-2">Enter Access Code</h2>
          <p className="text-on-surface-variant mb-6">This exam is password-protected. Enter the code provided by your instructor.</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Access code"
            className="w-full text-center tracking-widest font-bold text-xl py-3 bg-surface border border-outline-variant rounded-lg focus:border-secondary outline-none mb-2" />
          {codeErr && <p className="text-error text-sm mb-2">{codeErr}</p>}
          <div className="flex gap-3 mt-4">
            <button onClick={() => nav("/exams")} className="flex-1 border border-primary text-primary py-3 rounded-lg font-semibold">Cancel</button>
            <button onClick={verifyCode} className="flex-1 bg-primary text-on-primary py-3 rounded-lg font-semibold">Verify &amp; Start</button>
          </div>
        </div>
      </Layout>
    );
  }

  if (startError) {
    return (
      <Layout title="Exam">
        <div className="max-w-md mx-auto bg-surface-container-lowest border border-outline-variant rounded-xl p-8 mt-10 text-center">
          <div className="w-16 h-16 mx-auto bg-error-container text-on-error-container rounded-full flex items-center justify-center mb-4">
            <Icon name="block" className="text-[32px]" />
          </div>
          <h2 className="font-headline text-2xl text-primary mb-2">Can't Start Exam</h2>
          <p className="text-on-surface-variant mb-6">{startError}</p>
          <button onClick={() => nav("/exams")} className="w-full bg-primary text-on-primary py-3 rounded-lg font-semibold">
            Back to Exams
          </button>
        </div>
      </Layout>
    );
  }

  if (waiting && exam) {
    return (
      <Layout title="Live Quiz Lobby">
        <div className="max-w-lg mx-auto bg-surface-container-lowest border border-outline-variant rounded-2xl p-10 mt-10 text-center">
          <div className="w-16 h-16 mx-auto bg-secondary-container text-on-secondary-container rounded-full flex items-center justify-center mb-5">
            <Icon name="group" className="text-[34px]" />
          </div>
          <h2 className="font-headline text-2xl text-primary mb-2">You are in the lobby</h2>
          <p className="font-semibold text-on-surface mb-2">{exam.title}</p>
          <p className="text-on-surface-variant mb-6">Your teacher can now see that you joined. The quiz and timer will open for everyone when the teacher starts the session.</p>
          <div className="flex items-center justify-center gap-2 text-secondary font-semibold">
            <span className="w-2.5 h-2.5 rounded-full bg-secondary animate-pulse" /> Waiting for teacher to start…
          </div>
        </div>
      </Layout>
    );
  }

  if (needCode == null || !exam) {
    return <Layout title="Exam"><p className="text-on-surface-variant">Loading…</p></Layout>;
  }

  const q = questions[idx];

  return (
    <Layout title={exam.title}>
      <div className="max-w-3xl mx-auto">
        {/* Status bar */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-secondary">Question {questions.length ? idx + 1 : 0} of {questions.length}</span>
            {q && <><span className="text-outline-variant">•</span><span className="text-on-surface-variant">{q.points} pts</span></>}
          </div>
          <div className="flex items-center gap-4">
            {secondsLeft != null && (
              <span className={`flex items-center gap-1 px-4 py-2 rounded-lg font-bold font-mono ${secondsLeft < 300 ? "bg-error-container text-on-error-container animate-pulse" : "bg-surface-container-high text-primary"}`}>
                <Icon name="timer" className="text-base" /> {fmt(secondsLeft)}
              </span>
            )}
            <button onClick={() => { if (confirm("Submit your exam?")) submit(); }}
              className="bg-primary text-on-primary px-6 py-2 rounded-lg font-semibold">Submit Exam</button>
          </div>
        </div>

        {/* Progress dots */}
        <div className="flex gap-1 mb-6 flex-wrap">
          {questions.map((_, i) => (
            <div key={i} className={`w-2.5 h-2.5 rounded-full ${i === idx ? "bg-primary ring-2 ring-primary ring-offset-2" : responses[questions[i].id] ? "bg-secondary" : "bg-surface-container-highest"}`} />
          ))}
        </div>

        {/* Question card */}
        {q ? (
          <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-8">
            <h2 className="font-headline text-xl text-on-surface mb-6 leading-snug">{q.prompt}</h2>

            {q.type === "mcq" && Array.isArray(q.options) && (
              <div className="space-y-3">
                {q.options.map((opt: any, i: number) => (
                  <label key={i} className={`flex items-center gap-3 p-4 border-2 rounded-xl cursor-pointer transition-all ${responses[q.id]?.index === i ? "border-secondary bg-secondary-container/20" : "border-outline-variant hover:bg-surface-container-low"}`}>
                    <input type="radio" name={q.id} checked={responses[q.id]?.index === i} onChange={() => setResp(q.id, { index: i })} />
                    <span>{typeof opt === "string" ? opt : JSON.stringify(opt)}</span>
                  </label>
                ))}
              </div>
            )}

            {q.type === "true_false" && (
              <div className="flex gap-3">
                {[true, false].map((v) => (
                  <label key={String(v)} className={`flex-1 flex items-center justify-center gap-2 p-4 border-2 rounded-xl cursor-pointer ${responses[q.id]?.value === v ? "border-secondary bg-secondary-container/20" : "border-outline-variant hover:bg-surface-container-low"}`}>
                    <input type="radio" name={q.id} checked={responses[q.id]?.value === v} onChange={() => setResp(q.id, { value: v })} />
                    {v ? "True" : "False"}
                  </label>
                ))}
              </div>
            )}

            {(q.type === "fill_blank" || q.type === "short_answer" || q.type === "essay") && (
              <textarea rows={q.type === "essay" ? 6 : 2} value={responses[q.id]?.text || ""}
                onChange={(e) => setResp(q.id, { text: e.target.value })} placeholder="Your answer…"
                className="w-full border border-outline-variant rounded-lg p-3 outline-none focus:border-secondary" />
            )}

            {q.type === "matching" && q.options?.left && (
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="space-y-2">{q.options.left.map((l: string, i: number) => <div key={i} className="p-3 bg-surface-container rounded">{l}</div>)}</div>
                <div className="space-y-2">{q.options.right.map((r: string, i: number) => <div key={i} className="p-3 bg-secondary-container/40 rounded">{r}</div>)}</div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-on-surface-variant">This exam has no questions yet.</p>
        )}

        {/* Nav */}
        {q && (
          <div className="flex justify-between items-center mt-6">
            <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}
              className="flex items-center gap-2 px-6 py-3 border border-primary text-primary rounded-lg font-semibold disabled:opacity-40">
              <Icon name="arrow_back" className="text-lg" /> Previous
            </button>
            {idx < questions.length - 1 ? (
              <button onClick={() => setIdx((i) => Math.min(questions.length - 1, i + 1))}
                className="flex items-center gap-2 px-8 py-3 bg-primary text-on-primary rounded-lg font-semibold">
                Next Question <Icon name="arrow_forward" className="text-lg" />
              </button>
            ) : (
              <button onClick={() => { if (confirm("Submit your exam?")) submit(); }} disabled={busy}
                className="px-8 py-3 bg-secondary text-on-secondary rounded-lg font-semibold disabled:opacity-60">
                {busy ? "Submitting…" : "Finish & Submit"}
              </button>
            )}
          </div>
        )}
      </div>
    </Layout>
  );
}
