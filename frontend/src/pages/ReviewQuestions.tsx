import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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

interface Draft {
  prompt: string;
  points: number;
  options: any;
  answer: any;
}

interface ReviewQuestionsProps { embedded?: boolean; subjectId?: string }

export default function ReviewQuestions({ embedded = false, subjectId: controlledSubjectId }: ReviewQuestionsProps = {}) {
  const qc = useQueryClient();
  const [localSubjectId, setLocalSubjectId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [examTitle, setExamTitle] = useState("AI-Generated Exam");
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

  const createExam = useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ id: string; questions_added: number }>("/exams", {
        subject_id: sid,
        title: examTitle,
        question_ids: ids,
      }),
    onSuccess: (r) => {
      setMsg(`Created exam with ${r.questions_added} question(s). Publish it on the Exams page.`);
      setSelected({});
      qc.invalidateQueries({ queryKey: ["generated", sid] });
      qc.invalidateQueries({ queryKey: ["exams"] });
    },
  });

  const chosen = Object.keys(selected).filter((k) => selected[k]);

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
      <div className="flex items-center gap-3 bg-surface-container-lowest border border-outline-variant rounded-xl p-4 mb-6">
        <input value={examTitle} onChange={(e) => setExamTitle(e.target.value)}
          placeholder="Exam title"
          className="flex-1 border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
        <button onClick={() => approveAll.mutate()} disabled={approveAll.isPending || pending.length === 0}
          className="px-5 py-2 border border-secondary text-secondary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50">
          {approveAll.isPending ? "Approving…" : `Approve all (${pending.length})`}
        </button>
        <button onClick={() => createExam.mutate(chosen)} disabled={createExam.isPending || chosen.length === 0}
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
    </>
  );
  return embedded ? content : <Layout title="Review Questions">{content}</Layout>;
}

// ---- per-type answer editor ----
function AnswerEditor({ q, draft, setDraft }: { q: Question; draft: Draft; setDraft: (p: Partial<Draft>) => void }) {
  if (q.type === "mcq") {
    const opts: string[] = Array.isArray(draft.options) ? draft.options.map(asText) : [];
    const correct = draft.answer?.correct_index ?? 0;
    return (
      <div className="space-y-1.5">
        <label className="text-[11px] font-bold uppercase tracking-wider text-outline">Options</label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {opts.map((o, i) => (
            <label key={i}
              className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${i === correct ? "border-secondary bg-secondary-container/30" : "border-outline-variant bg-surface"}`}>
              <input type="radio" name={`ans-${q.id}`} checked={i === correct}
                onChange={() => setDraft({ answer: { correct_index: i } })} className="text-secondary" />
              <input value={o}
                onChange={(e) => {
                  const copy = [...opts]; copy[i] = e.target.value;
                  setDraft({ options: copy });
                }}
                className="flex-1 bg-transparent border-none p-0 text-sm focus:ring-0" />
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
        <label className="text-[11px] font-bold uppercase tracking-wider text-outline">Correct Answer</label>
        <div className="flex gap-3">
          {[true, false].map((v) => (
            <label key={String(v)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg border cursor-pointer ${correct === v ? "border-secondary bg-secondary-container/30 text-secondary" : "border-outline-variant"}`}>
              <input type="radio" name={`ans-${q.id}`} checked={correct === v}
                onChange={() => setDraft({ answer: { correct: v } })} className="text-secondary" />
              <span className="font-semibold">{v ? "True" : "False"}</span>
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
        <label className="text-[11px] font-bold uppercase tracking-wider text-outline">Accepted Answer(s) — comma separated</label>
        <input value={accepted.join(", ")}
          onChange={(e) => setDraft({ answer: { accepted: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } })}
          className="w-full bg-surface border border-outline-variant rounded-lg p-2.5 text-sm outline-none focus:border-secondary" />
      </div>
    );
  }

  if (q.type === "matching") {
    const left: string[] = Array.isArray(draft.options?.left) ? draft.options.left.map(asText) : [];
    const right: string[] = Array.isArray(draft.options?.right) ? draft.options.right.map(asText) : [];
    return (
      <div className="space-y-1.5">
        <label className="text-[11px] font-bold uppercase tracking-wider text-outline">Pairs</label>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="space-y-2">{left.map((l, i) => <div key={i} className="p-2 bg-surface-container rounded">{l}</div>)}</div>
          <div className="space-y-2">{right.map((r, i) => <div key={i} className="p-2 bg-secondary-container/40 rounded">{r}</div>)}</div>
        </div>
      </div>
    );
  }

  if (q.type === "essay") {
    const rubric = asText(draft.answer?.rubric);
    return (
      <div className="space-y-1.5">
        <label className="text-[11px] font-bold uppercase tracking-wider text-outline">Grading Rubric</label>
        <textarea rows={2} value={rubric}
          onChange={(e) => setDraft({ answer: { rubric: e.target.value } })}
          className="w-full bg-surface border border-outline-variant rounded-lg p-3 text-sm outline-none focus:border-secondary" />
      </div>
    );
  }

  return null;
}
