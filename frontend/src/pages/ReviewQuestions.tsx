import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Layout, { Icon } from "../components/Layout";
import { api, Subject, Question } from "../api";

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

const diffStyle: Record<string, string> = {
  easy: "bg-green-100 text-green-800 border border-green-200",
  medium: "bg-orange-100 text-orange-800 border border-orange-200",
  hard: "bg-error-container text-on-error-container",
};

const typeLabel: Record<string, string> = {
  mcq: "Multiple Choice",
  true_false: "True / False",
  fill_blank: "Fill-in-the-blank",
  matching: "Matching Type",
  essay: "Essay",
};
const typeOrder = ["mcq", "true_false", "fill_blank", "matching", "essay"];

interface Draft {
  prompt: string;
  points: number;
  options: any;
  answer: any;
}

interface ReviewQuestionsProps { embedded?: boolean; subjectId?: string }

export default function ReviewQuestions({ embedded = false, subjectId: controlledSubjectId }: ReviewQuestionsProps = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [localSubjectId, setLocalSubjectId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [examTitle, setExamTitle] = useState("");
  const [examMode, setExamMode] = useState<"take_home" | "live">("take_home");
  const [durationMin, setDurationMin] = useState(60);
  const [dueAt, setDueAt] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [orderMode, setOrderMode] = useState<"current" | "type" | "shuffle">("current");
  const [shuffledIds, setShuffledIds] = useState<string[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [msg, setMsg] = useState("");

  const { data: subjects = [] } = useQuery({
    queryKey: ["subjects"],
    queryFn: () => api.get<Subject[]>("/subjects"),
  });
  const sid = controlledSubjectId || localSubjectId || subjects[0]?.id || "";

  const { data: pending = [] } = useQuery({
    queryKey: ["generated", sid],
    queryFn: () => api.get<Question[]>(`/subjects/${sid}/generated?status=pending`),
    enabled: !!sid,
  });
  const { data: approved = [] } = useQuery({
    queryKey: ["generated", sid, "approved"],
    queryFn: () => api.get<Question[]>(`/subjects/${sid}/generated?status=approved`),
    enabled: !!sid,
  });
  const questions = useMemo(() => [...pending, ...approved], [pending, approved]);

  // Seed editable drafts from loaded questions.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const q of questions) {
        if (!next[q.id]) {
          next[q.id] = {
            prompt: asText(q.prompt),
            points: q.points ?? 1,
            options: q.options ?? null,
            answer: q.answer ?? {},
          };
        }
      }
      return next;
    });
  }, [questions]);

  useEffect(() => { setSelected({}); }, [sid]);

  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const save = useMutation({
    mutationFn: ({ id, d }: { id: string; d: Draft }) =>
      api.patch(`/generated/${id}`, {
        prompt: d.prompt,
        points: Number(d.points) || 1,
        options: d.options,
        answer: d.answer,
      }),
    onSuccess: () => setMsg("Saved."),
  });

  const reject = useMutation({
    mutationFn: (id: string) => api.patch(`/generated/${id}`, { status: "rejected" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["generated", sid] }),
  });

  const approveAll = useMutation({
    mutationFn: async () => {
      await Promise.all(pending.map((question) => {
        const draft = drafts[question.id] || {
          prompt: asText(question.prompt), points: question.points ?? 1,
          options: question.options ?? null, answer: question.answer ?? {},
        };
        return api.patch(`/generated/${question.id}`, {
          status: "approved", prompt: draft.prompt, points: Number(draft.points) || 1,
          options: draft.options, answer: draft.answer,
        });
      }));
      return pending.map((question) => question.id);
    },
    onSuccess: (ids) => {
      setSelected((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, true])) }));
      setMsg(`Approved ${ids.length} question(s). They are selected and ready to add to an exam.`);
      qc.invalidateQueries({ queryKey: ["generated", sid] });
    },
    onError: (error: Error) => setMsg(`Approval failed: ${error.message}`),
  });

  const deleteAll = useMutation({
    mutationFn: () => api.del<{ deleted: number }>(`/subjects/${sid}/generated`),
    onSuccess: (result) => {
      setDrafts({});
      setSelected({});
      setMsg(`Deleted ${result.deleted} generated question(s). Questions already added to exams were not affected.`);
      qc.invalidateQueries({ queryKey: ["generated", sid] });
    },
    onError: (error: Error) => setMsg(`Delete failed: ${error.message}`),
  });

  const createExam = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ id: string; questions_added: number }>("/exams", {
        subject_id: sid,
        title: examTitle,
        exam_mode: examMode,
        duration_min: durationMin,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        access_code: examMode === "live" ? accessCode.trim() : "",
        publish: true,
        question_ids: ids,
      }),
    onSuccess: (r) => {
      setMsg(`${examMode === "live" ? "Live" : "Take-home"} quiz published with ${r.questions_added} question(s).`);
      setSelected({});
      qc.invalidateQueries({ queryKey: ["generated", sid] });
      qc.invalidateQueries({ queryKey: ["exams"] });
      if (examMode === "live") {
        navigate(`/exams/${r.id}/monitor`);
      }
    },
  });

  const chosen = Object.keys(selected).filter((k) => selected[k]);
  const orderedQuestions = useMemo(() => {
    const included = questions.filter((question) => selected[question.id]);
    if (orderMode === "type") {
      return [...included].sort((a, b) => {
        const ai = typeOrder.indexOf(a.type);
        const bi = typeOrder.indexOf(b.type);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
    }
    if (orderMode === "shuffle") {
      const rank = new Map(shuffledIds.map((questionId, index) => [questionId, index]));
      return [...included].sort((a, b) => (rank.get(a.id) ?? 9999) - (rank.get(b.id) ?? 9999));
    }
    return included;
  }, [questions, selected, orderMode, shuffledIds]);
  const orderedIds = orderedQuestions.map((question) => question.id);

  const shuffleQuestions = () => {
    const ids = questions.filter((question) => selected[question.id]).map((question) => question.id);
    for (let index = ids.length - 1; index > 0; index--) {
      const swapWith = Math.floor(Math.random() * (index + 1));
      [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
    }
    setShuffledIds(ids);
    setOrderMode("shuffle");
  };

  const content = (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="font-headline text-xl text-primary">Review Generated Questions</h3>
          <p className="text-on-surface-variant text-sm">
            Edit, save, and select questions to build an exam.
          </p>
        </div>
        {!controlledSubjectId && (
          <select value={sid} onChange={(e) => setLocalSubjectId(e.target.value)}
            className="border border-outline-variant rounded-lg px-3 py-2 bg-white">
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
          </select>
        )}
      </div>

      {/* Sticky build bar */}
      <div className="flex flex-wrap items-center gap-3 bg-surface-container-lowest border border-outline-variant rounded-xl p-4 mb-6">
        <input value={examTitle} onChange={(e) => setExamTitle(e.target.value)}
          placeholder="Exam title"
          className="min-w-52 flex-1 border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
        <select value={examMode} onChange={(e) => setExamMode(e.target.value as "take_home" | "live")}
          className="border border-outline-variant rounded-lg px-3 py-2 bg-white">
          <option value="take_home">Take-home quiz</option>
          <option value="live">Live quiz</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          <input type="number" min={1} value={durationMin} onChange={(e) => setDurationMin(Math.max(1, Number(e.target.value)))}
            className="w-20 border border-outline-variant rounded-lg px-3 py-2 bg-white" /> min
        </label>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          Due
          <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
            className="border border-outline-variant rounded-lg px-3 py-2 bg-white" />
        </label>
        {examMode === "live" && (
          <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="Live access code"
            className="w-44 border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
        )}
        <button onClick={() => approveAll.mutate()} disabled={approveAll.isPending || pending.length === 0}
          className="px-5 py-2 border border-secondary text-secondary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50">
          {approveAll.isPending ? "Approving…" : `Approve all (${pending.length})`}
        </button>
        <button
          onClick={() => setSelected(Object.fromEntries(questions.map((question) => [question.id, true])))}
          disabled={questions.length === 0 || chosen.length === questions.length}
          className="px-5 py-2 border border-primary text-primary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50">
          Include all ({questions.length})
        </button>
        <button onClick={() => setSelected({})} disabled={chosen.length === 0}
          className="px-5 py-2 border border-outline-variant text-on-surface-variant rounded-lg font-semibold whitespace-nowrap disabled:opacity-50">
          Uninclude all
        </button>
        <select value={orderMode} onChange={(event) => {
          const mode = event.target.value as "current" | "type" | "shuffle";
          if (mode === "shuffle") shuffleQuestions(); else setOrderMode(mode);
        }} disabled={chosen.length === 0}
          className="border border-outline-variant rounded-lg px-3 py-2 bg-white font-semibold text-sm disabled:opacity-50">
          <option value="current">Current order</option>
          <option value="type">Group by question type</option>
          <option value="shuffle">Shuffle questions</option>
        </select>
        {orderMode === "shuffle" && (
          <button onClick={shuffleQuestions} disabled={chosen.length < 2}
            className="px-4 py-2 border border-secondary text-secondary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50 flex items-center gap-1">
            <Icon name="shuffle" className="text-[18px]" /> Reshuffle
          </button>
        )}
        <button onClick={() => setShowPreview(true)} disabled={chosen.length === 0}
          className="px-5 py-2 border border-primary text-primary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50 flex items-center gap-1">
          <Icon name="visibility" className="text-[18px]" /> Preview exam
        </button>
        <button onClick={() => {
          if (confirm(`Delete all ${questions.length} generated question(s) for this subject? This cannot be undone.`)) {
            deleteAll.mutate();
          }
        }} disabled={deleteAll.isPending || questions.length === 0}
          className="px-5 py-2 border border-error text-error rounded-lg font-semibold whitespace-nowrap hover:bg-error-container disabled:opacity-50">
          {deleteAll.isPending ? "Deleting…" : `Delete all (${questions.length})`}
        </button>
        <button onClick={() => createExam.mutate(orderedIds)}
          disabled={createExam.isPending || chosen.length === 0 || !examTitle.trim() || (examMode === "live" && !accessCode.trim())}
          className="px-6 py-2 bg-primary text-on-primary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50">
          Create exam ({chosen.length})
        </button>
      </div>
      {msg && <p className="text-sm text-secondary mb-4">{msg}</p>}

      <div className="space-y-6">
        {questions.map((q, idx) => {
          const d = drafts[q.id] || { prompt: asText(q.prompt), points: q.points, options: q.options, answer: q.answer };
          const isSel = !!selected[q.id];
          return (
            <section key={q.id}
              className={`bg-surface-container-lowest border rounded-xl shadow-sm overflow-hidden transition-all ${isSel ? "border-secondary ring-1 ring-secondary" : "border-outline-variant"}`}>
              <div className="p-6 space-y-4">
                {/* Header row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded bg-primary text-on-primary flex items-center justify-center font-bold text-sm">
                      {String(idx + 1).padStart(2, "0")}
                    </span>
                    <div className="flex gap-2 flex-wrap items-center">
                      <span className="px-3 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-xs font-semibold">
                        {typeLabel[q.type] || asText(q.type)}
                      </span>
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${diffStyle[q.difficulty] || "bg-surface-container-high"}`}>
                        {asText(q.difficulty)}
                      </span>
                      <span className="flex items-center gap-1 px-3 py-1 rounded-full bg-surface-container-high text-on-surface-variant text-xs border border-outline-variant">
                        <Icon name="grade" className="text-[14px]" />
                        <input type="number" min={1} value={d.points}
                          onChange={(e) => setDraft(q.id, { points: Number(e.target.value) })}
                          className="w-8 bg-transparent border-none p-0 focus:ring-0 text-xs" /> pts
                      </span>
                      {q.topic && (
                        <span className="px-3 py-1 rounded-full bg-secondary-container text-on-secondary-container text-xs">
                          {asText(q.topic)}
                        </span>
                      )}
                      <span className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${q.status === "approved" ? "bg-green-100 text-green-800" : "bg-orange-100 text-orange-800"}`}>
                        {q.status || "pending"}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-on-surface-variant cursor-pointer mr-1">
                      <input type="checkbox" checked={isSel}
                        onChange={(e) => setSelected((s) => ({ ...s, [q.id]: e.target.checked }))} />
                      Include
                    </label>
                    <button onClick={() => reject.mutate(q.id)}
                      className="p-2 text-on-surface-variant hover:bg-error-container hover:text-error rounded transition-colors" title="Reject">
                      <Icon name="delete" />
                    </button>
                  </div>
                </div>

                {/* Question text */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-outline">Question Text</label>
                  <textarea rows={2} value={d.prompt}
                    onChange={(e) => setDraft(q.id, { prompt: e.target.value })}
                    className="w-full bg-surface border border-outline-variant rounded-lg p-3 text-body-md focus:ring-2 focus:ring-secondary/20 focus:border-secondary outline-none" />
                </div>

                {/* Answer editor by type */}
                <AnswerEditor q={q} draft={d} setDraft={(p) => setDraft(q.id, p)} />

                {/* Source reference */}
                {q.source_ref && (
                  <details className="group border-t border-outline-variant pt-3">
                    <summary className="flex items-center gap-2 cursor-pointer text-secondary text-sm font-semibold list-none">
                      <Icon name="expand_more" className="transition-transform group-open:rotate-180" />
                      View Source Reference
                    </summary>
                    <div className="mt-3 p-3 bg-surface rounded-lg border-l-4 border-secondary text-on-surface-variant italic text-sm">
                      {asText(q.source_ref)}
                    </div>
                  </details>
                )}
              </div>

              {/* Footer */}
              <div className="bg-surface-container-low px-6 py-3 flex justify-end gap-3">
                <button onClick={() => reject.mutate(q.id)}
                  className="text-on-surface-variant text-sm font-semibold hover:text-error">Discard</button>
                <button onClick={() => save.mutate({ id: q.id, d })}
                  disabled={save.isPending}
                  className="bg-secondary text-on-secondary px-4 py-1.5 rounded-lg text-sm font-semibold hover:opacity-90 disabled:opacity-60">
                  Save Changes
                </button>
              </div>
            </section>
          );
        })}

        {questions.length === 0 && (
          <p className="text-on-surface-variant">No generated questions yet. Use the generator above.</p>
        )}
      </div>

      {showPreview && (
        <div className="fixed inset-0 z-50 bg-primary/35 backdrop-blur-sm p-4 md:p-8 overflow-y-auto" onClick={() => setShowPreview(false)}>
          <div className="max-w-4xl mx-auto bg-surface-container-lowest rounded-2xl shadow-2xl border border-outline-variant overflow-hidden"
            onClick={(event) => event.stopPropagation()}>
            <div className="sticky top-0 z-10 bg-surface-container-lowest border-b border-outline-variant px-6 py-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-widest text-secondary font-bold">Exam preview</p>
                <h2 className="font-headline text-2xl font-bold text-primary">{examTitle.trim() || "Untitled exam"}</h2>
                <p className="text-sm text-on-surface-variant mt-1">{orderedQuestions.length} questions · {durationMin} minutes · {orderMode === "type" ? "Grouped by type" : orderMode === "shuffle" ? "Shuffled order" : "Current order"}</p>
              </div>
              <button onClick={() => setShowPreview(false)} className="w-10 h-10 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant">
                <Icon name="close" />
              </button>
            </div>
            <div className="p-6 md:p-8 space-y-5 bg-surface-container-low">
              {orderedQuestions.map((question, index) => {
                const draft = drafts[question.id] || { prompt: asText(question.prompt), points: question.points, options: question.options, answer: question.answer };
                const startsSection = orderMode === "type" && (index === 0 || orderedQuestions[index - 1].type !== question.type);
                const sectionNumber = new Set(orderedQuestions.slice(0, index + 1).map((item) => item.type)).size;
                return <div key={question.id}>
                  {startsSection && (
                    <div className="flex items-center gap-3 mb-3 mt-2">
                      <span className="bg-primary text-on-primary px-3 py-1 rounded-lg text-sm font-bold">Test {sectionNumber}</span>
                      <h3 className="font-headline text-lg font-bold text-primary">{typeLabel[question.type] || question.type}</h3>
                      <div className="h-px bg-outline-variant flex-1" />
                    </div>
                  )}
                  <article className="bg-white border border-outline-variant rounded-xl p-6">
                    <div className="flex items-start gap-4">
                      <span className="w-8 h-8 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center font-bold text-sm shrink-0">{index + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between gap-3"><p className="font-semibold text-on-surface leading-6">{draft.prompt}</p><span className="text-xs text-on-surface-variant whitespace-nowrap">{draft.points} pts</span></div>
                        <PreviewOptions question={question} options={draft.options} />
                      </div>
                    </div>
                  </article>
                </div>;
              })}
            </div>
            <div className="sticky bottom-0 bg-surface-container-lowest border-t border-outline-variant px-6 py-4 flex justify-end gap-3">
              {orderMode === "shuffle" && <button onClick={shuffleQuestions} className="border border-secondary text-secondary px-4 py-2 rounded-lg font-semibold flex items-center gap-2"><Icon name="shuffle" /> Reshuffle</button>}
              <button onClick={() => setShowPreview(false)} className="bg-primary text-on-primary px-6 py-2 rounded-lg font-semibold">Done previewing</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
  return embedded ? content : <Layout title="Review Questions">{content}</Layout>;
}

function PreviewOptions({ question, options }: { question: Question; options: any }) {
  if (question.type === "mcq" && Array.isArray(options)) {
    return <div className="grid sm:grid-cols-2 gap-2 mt-4">{options.map((option, index) =>
      <div key={index} className="border border-outline-variant rounded-lg px-3 py-2 text-sm text-on-surface-variant flex gap-2"><span className="font-bold">{String.fromCharCode(65 + index)}.</span>{asText(option)}</div>
    )}</div>;
  }
  if (question.type === "true_false") {
    return <div className="flex gap-2 mt-4"><span className="border border-outline-variant rounded-lg px-5 py-2 text-sm">True</span><span className="border border-outline-variant rounded-lg px-5 py-2 text-sm">False</span></div>;
  }
  if (question.type === "matching" && options?.left && options?.right) {
    return <div className="grid grid-cols-2 gap-3 mt-4 text-sm"><div className="space-y-1">{options.left.map((item: unknown, index: number) => <p key={index} className="bg-surface-container-low rounded px-3 py-2">{index + 1}. {asText(item)}</p>)}</div><div className="space-y-1">{options.right.map((item: unknown, index: number) => <p key={index} className="bg-surface-container-low rounded px-3 py-2">{String.fromCharCode(65 + index)}. {asText(item)}</p>)}</div></div>;
  }
  if (["fill_blank", "short_answer", "essay"].includes(question.type)) {
    return <div className="mt-4 border-b border-outline-variant h-8 text-xs text-on-surface-variant">Student answer</div>;
  }
  return null;
}

// ---- per-type answer editor ----
function AnswerEditor({ q, draft, setDraft }: { q: Question; draft: Draft; setDraft: (p: Partial<Draft>) => void }) {
  if (q.type === "mcq") {
    const opts: string[] = Array.isArray(draft.options) ? draft.options.map(asText) : [];
    const correct = draft.answer?.correct_index ?? 0;
    return (
      <div className="space-y-1.5">
        <AiAnswerHeading label="Options" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {opts.map((o, i) => (
            <label key={i}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${i === correct ? "border-primary/40 bg-primary/5 text-primary ring-1 ring-primary/20" : "border-outline-variant bg-surface"}`}>
              <input type="radio" name={`ans-${q.id}`} checked={i === correct}
                onChange={() => setDraft({ answer: { correct_index: i } })} className="accent-primary" />
              <input value={o}
                onChange={(e) => {
                  const copy = [...opts]; copy[i] = e.target.value;
                  setDraft({ options: copy });
                }}
                className="flex-1 bg-transparent border-none p-0 text-sm focus:ring-0" />
              {i === correct && <span className="text-[10px] uppercase tracking-wide font-bold bg-primary text-on-primary px-2 py-1 rounded-full">AI answer</span>}
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (q.type === "true_false") {
    const correct = draft.answer?.correct === true;
    return (
      <div className="space-y-1.5">
        <AiAnswerHeading label="Correct Answer" />
        <div className="flex gap-3">
          {[true, false].map((v) => (
            <label key={String(v)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer ${correct === v ? "border-primary/40 bg-primary/5 text-primary ring-1 ring-primary/20" : "border-outline-variant"}`}>
              <input type="radio" name={`ans-${q.id}`} checked={correct === v}
                onChange={() => setDraft({ answer: { correct: v } })} className="accent-primary" />
              <span className="font-semibold">{v ? "True" : "False"}</span>
              {correct === v && <span className="text-[10px] uppercase tracking-wide font-bold bg-primary text-on-primary px-2 py-1 rounded-full">AI answer</span>}
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (q.type === "fill_blank") {
    const accepted: string[] = Array.isArray(draft.answer?.accepted) ? draft.answer.accepted.map(asText) : [];
    return (
      <div className="space-y-1.5">
        <AiAnswerHeading label="Accepted Answer(s) — comma separated" />
        <input value={accepted.join(", ")}
          onChange={(e) => setDraft({ answer: { accepted: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })}
          className="w-full bg-primary/5 border border-primary/40 text-primary rounded-lg p-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
      </div>
    );
  }

  if (q.type === "matching") {
    const left: string[] = Array.isArray(draft.options?.left) ? draft.options.left.map(asText) : [];
    const right: string[] = Array.isArray(draft.options?.right) ? draft.options.right.map(asText) : [];
    const pairs: number[][] = Array.isArray(draft.answer?.pairs) ? draft.answer.pairs : [];
    return (
      <div className="space-y-1.5">
        <AiAnswerHeading label="Correct Pairs" />
        <div className="space-y-2 text-sm">
          {pairs.map(([leftIndex, rightIndex], index) => (
            <div key={index} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-3 rounded-lg border border-primary/40 bg-primary/5 text-primary">
              <span className="font-semibold">{left[leftIndex]}</span><Icon name="arrow_forward" className="text-[18px]" /><span>{right[rightIndex]}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (q.type === "essay") {
    const rubric = asText(draft.answer?.rubric);
    return (
      <div className="space-y-1.5">
        <AiAnswerHeading label="Grading Rubric" />
        <textarea rows={2} value={rubric}
          onChange={(e) => setDraft({ answer: { rubric: e.target.value } })}
          className="w-full bg-primary/5 border border-primary/40 text-primary rounded-lg p-3 text-sm outline-none focus:ring-2 focus:ring-primary/20" />
      </div>
    );
  }

  return null;
}

function AiAnswerHeading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-bold uppercase tracking-wider text-outline">{label}</span>
      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide font-bold text-primary bg-primary/10 border border-primary/20 px-2 py-0.5 rounded-full">
        <Icon name="auto_awesome" className="text-[13px]" /> AI-provided answer
      </span>
    </div>
  );
}
