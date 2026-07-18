import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Layout, { Icon } from "../components/Layout";
import QuestionPrompt, { QUESTION_IMAGE_TOKEN, insertQuestionImageToken } from "../components/QuestionPrompt";
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

interface BankGroup {
  group_type: "exam" | "generated";
  title: string;
  exam_id?: string;
  status?: string;
  exam_mode?: "take_home" | "live";
  questions: Question[];
}

type ReviewQuestion = Question & { source_kind: "generated" | "bank"; bank_title?: string };

interface ReviewQuestionsProps { embedded?: boolean; subjectId?: string }

export default function ReviewQuestions({ embedded = false, subjectId: controlledSubjectId }: ReviewQuestionsProps = {}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [localSubjectId, setLocalSubjectId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [selectedBank, setSelectedBank] = useState<Record<string, boolean>>({});
  const [examTitle, setExamTitle] = useState("");
  const [examMode, setExamMode] = useState<"take_home" | "live">("take_home");
  const [durationMin, setDurationMin] = useState(60);
  const [startsAt, setStartsAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [orderMode, setOrderMode] = useState<"current" | "type" | "shuffle">("current");
  const [shuffledIds, setShuffledIds] = useState<string[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [msg, setMsg] = useState("");
  const promptRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

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
  const { data: bankData } = useQuery<{ groups: BankGroup[] }>({
    queryKey: ["question-bank", sid],
    queryFn: () => api.get<{ groups: BankGroup[] }>(`/subjects/${sid}/question-bank`),
    enabled: !!sid,
  });
  const questions = useMemo(() => [...pending, ...approved], [pending, approved]);
  const generatedReviewQuestions = useMemo<ReviewQuestion[]>(
    () => questions.map((question) => ({ ...question, source_kind: "generated" })),
    [questions],
  );
  const bankGroups = useMemo(
    () => (bankData?.groups || []).filter((group) => group.group_type === "exam" && group.questions.length > 0),
    [bankData],
  );
  const bankQuestions = useMemo<ReviewQuestion[]>(
    () => bankGroups.flatMap((group) => group.questions.map((question) => ({
      ...question,
      source_kind: "bank" as const,
      bank_title: group.title,
    }))),
    [bankGroups],
  );

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

  useEffect(() => {
    setSelected({});
    setSelectedBank({});
  }, [sid]);

  const setDraft = (id: string, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));

  const insertInlineImage = (question: Question) => {
    const draft = drafts[question.id] || {
      prompt: asText(question.prompt),
      points: question.points ?? 1,
      options: question.options ?? null,
      answer: question.answer ?? {},
    };
    const input = promptRefs.current[question.id];
    const nextPrompt = insertQuestionImageToken(draft.prompt, input?.selectionStart, input?.selectionEnd);
    setDraft(question.id, { prompt: nextPrompt });
    requestAnimationFrame(() => {
      const current = promptRefs.current[question.id];
      current?.focus();
      const tokenIndex = nextPrompt.indexOf(QUESTION_IMAGE_TOKEN);
      if (current && tokenIndex >= 0) current.setSelectionRange(tokenIndex, tokenIndex + QUESTION_IMAGE_TOKEN.length);
    });
  };

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
    mutationFn: ({ refs, publish }: { refs: { id: string; source: "generated" | "bank" }[]; publish: boolean }) =>
      api.post<{ id: string; questions_added: number }>("/exams", {
        subject_id: sid,
        title: examTitle,
        exam_mode: examMode,
        duration_min: durationMin,
        starts_at: examMode === "take_home" && startsAt ? new Date(startsAt).toISOString() : null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        access_code: examMode === "live" ? accessCode.trim() : "",
        publish,
        question_refs: refs,
      }),
    onSuccess: (r, variables) => {
      setMsg(`${examMode === "live" ? "Live" : "Take-home"} quiz ${variables.publish ? "published" : "saved as a draft"} with ${r.questions_added} question(s).`);
      setShowPreview(false);
      setSelected({});
      setSelectedBank({});
      qc.invalidateQueries({ queryKey: ["generated", sid] });
      qc.invalidateQueries({ queryKey: ["question-bank", sid] });
      qc.invalidateQueries({ queryKey: ["exams"] });
      if (variables.publish) {
        navigate(`/subjects/${sid}`);
      }
    },
    onError: (error: Error) => setMsg(`Exam creation failed: ${error.message}`),
  });

  const uploadQuestionImage = useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) =>
      api.upload<{ image_url: string }>(`/generated/${id}/image`, file),
    onSuccess: async (_result, variables) => {
      const question = questions.find((item) => item.id === variables.id);
      if (question) {
        const draft = drafts[question.id] || {
          prompt: asText(question.prompt),
          points: question.points ?? 1,
          options: question.options ?? null,
          answer: question.answer ?? {},
        };
        const input = promptRefs.current[question.id];
        const nextPrompt = insertQuestionImageToken(draft.prompt, input?.selectionStart, input?.selectionEnd);
        setDraft(question.id, { prompt: nextPrompt });
        await api.patch(`/generated/${question.id}`, { prompt: nextPrompt });
      }
      setMsg("Question image inserted.");
      qc.invalidateQueries({ queryKey: ["generated", sid] });
      qc.invalidateQueries({ queryKey: ["question-bank", sid] });
    },
    onError: (error: Error) => setMsg(`Image upload failed: ${error.message}`),
  });

  const removeQuestionImage = useMutation({
    mutationFn: (id: string) => api.del(`/generated/${id}/image`),
    onSuccess: () => {
      setMsg("Question image removed.");
      qc.invalidateQueries({ queryKey: ["generated", sid] });
      qc.invalidateQueries({ queryKey: ["question-bank", sid] });
    },
    onError: (error: Error) => setMsg(`Remove image failed: ${error.message}`),
  });

  const chosen = Object.keys(selected).filter((k) => selected[k]);
  const chosenBank = Object.keys(selectedBank).filter((k) => selectedBank[k]);
  const totalChosen = chosen.length + chosenBank.length;
  const orderedQuestions = useMemo(() => {
    const included = [
      ...generatedReviewQuestions.filter((question) => selected[question.id]),
      ...bankQuestions.filter((question) => selectedBank[question.id]),
    ];
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
  }, [generatedReviewQuestions, bankQuestions, selected, selectedBank, orderMode, shuffledIds]);
  const orderedRefs = orderedQuestions.map((question) => ({ id: question.id, source: question.source_kind }));

  const shuffleQuestions = () => {
    const ids = [
      ...generatedReviewQuestions.filter((question) => selected[question.id]).map((question) => question.id),
      ...bankQuestions.filter((question) => selectedBank[question.id]).map((question) => question.id),
    ];
    for (let index = ids.length - 1; index > 0; index--) {
      const swapWith = Math.floor(Math.random() * (index + 1));
      [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
    }
    setShuffledIds(ids);
    setOrderMode("shuffle");
  };

  const toggleBankGroup = (group: BankGroup) => {
    const ids = group.questions.map((question) => question.id);
    const allSelected = ids.every((id) => selectedBank[id]);
    setSelectedBank((current) => {
      const next = { ...current };
      ids.forEach((id) => { next[id] = !allSelected; });
      return next;
    });
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

      {/* Compact review actions. Exam settings live in the creation preview. */}
      <div className="flex flex-wrap items-center gap-3 bg-surface-container-lowest border border-outline-variant rounded-xl p-4 mb-6">
        <div className="mr-auto">
          <p className="font-semibold text-on-surface">{totalChosen} question{totalChosen === 1 ? "" : "s"} included</p>
          <p className="text-xs text-on-surface-variant">Select generated questions or reuse questions from previous exams.</p>
        </div>
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
        <button onClick={() => { setSelected({}); setSelectedBank({}); }} disabled={totalChosen === 0}
          className="px-5 py-2 border border-outline-variant text-on-surface-variant rounded-lg font-semibold whitespace-nowrap disabled:opacity-50">
          Uninclude all
        </button>
        <button onClick={() => {
          if (confirm(`Delete all ${questions.length} generated question(s) for this subject? This cannot be undone.`)) {
            deleteAll.mutate();
          }
        }} disabled={deleteAll.isPending || questions.length === 0}
          className="px-5 py-2 border border-error text-error rounded-lg font-semibold whitespace-nowrap hover:bg-error-container disabled:opacity-50">
          {deleteAll.isPending ? "Deleting…" : `Delete all (${questions.length})`}
        </button>
        <button onClick={() => setShowPreview(true)} disabled={totalChosen === 0}
          className="px-6 py-2 bg-primary text-on-primary rounded-lg font-semibold whitespace-nowrap disabled:opacity-50 flex items-center gap-2">
          <Icon name="arrow_forward" className="text-[18px]" /> Create exam
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
                  <textarea ref={(node) => { promptRefs.current[q.id] = node; }} rows={2} value={d.prompt}
                    onChange={(e) => setDraft(q.id, { prompt: e.target.value })}
                    className="w-full bg-surface border border-outline-variant rounded-lg p-3 text-body-md focus:ring-2 focus:ring-secondary/20 focus:border-secondary outline-none" />
                </div>

                <QuestionImageEditor
                  question={q}
                  uploading={uploadQuestionImage.isPending}
                  removing={removeQuestionImage.isPending}
                  onUpload={(file) => uploadQuestionImage.mutate({ id: q.id, file })}
                  onInsert={() => insertInlineImage(q)}
                  onRemove={() => removeQuestionImage.mutate(q.id)}
                />

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

      <section className="mt-8 bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div className="px-6 py-4 bg-surface-container-low border-b border-outline-variant flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Icon name="history_edu" className="text-secondary" />
              <h3 className="font-headline text-lg font-bold text-primary">Reuse Previous Exam Questions</h3>
            </div>
            <p className="text-sm text-on-surface-variant mt-1">
              Add questions from earlier quizzes when building finals or long exams.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowPreview(true)}
              disabled={totalChosen === 0}
              className="px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-semibold disabled:opacity-50 flex items-center gap-2">
              <Icon name="arrow_forward" className="text-[18px]" /> Create exam
            </button>
            <button
              onClick={() => setSelectedBank(Object.fromEntries(bankQuestions.map((question) => [question.id, true])))}
              disabled={bankQuestions.length === 0 || chosenBank.length === bankQuestions.length}
              className="px-4 py-2 border border-primary text-primary rounded-lg text-sm font-semibold disabled:opacity-50">
              Select all ({bankQuestions.length})
            </button>
            <button
              onClick={() => setSelectedBank({})}
              disabled={chosenBank.length === 0}
              className="px-4 py-2 border border-outline-variant text-on-surface-variant rounded-lg text-sm font-semibold disabled:opacity-50">
              Deselect all
            </button>
          </div>
        </div>
        {bankGroups.length === 0 ? (
          <p className="p-6 text-sm text-on-surface-variant">No previous exam questions yet.</p>
        ) : (
          <div className="divide-y divide-outline-variant">
            {bankGroups.map((group) => {
              const groupIds = group.questions.map((question) => question.id);
              const selectedCount = groupIds.filter((id) => selectedBank[id]).length;
              const allSelected = selectedCount === groupIds.length;
              return (
                <div key={group.exam_id || group.title} className="p-5">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
                    <div>
                      <h4 className="font-headline text-base font-bold text-primary">{group.title}</h4>
                      <p className="text-xs text-on-surface-variant">
                        {group.questions.length} question{group.questions.length === 1 ? "" : "s"} - {selectedCount} selected
                      </p>
                    </div>
                    <button
                      onClick={() => toggleBankGroup(group)}
                      className={`px-4 py-2 rounded-lg text-sm font-semibold border ${allSelected ? "border-outline-variant text-on-surface-variant" : "border-secondary text-secondary"}`}>
                      {allSelected ? "Deselect quiz" : "Select quiz"}
                    </button>
                  </div>
                  <div className="space-y-3">
                    {group.questions.map((question, index) => {
                      const isBankSelected = !!selectedBank[question.id];
                      return (
                        <label key={question.id}
                          className={`flex items-start gap-3 border rounded-lg p-4 cursor-pointer ${isBankSelected ? "border-secondary bg-secondary-container/20" : "border-outline-variant bg-white"}`}>
                          <input
                            type="checkbox"
                            checked={isBankSelected}
                            onChange={(event) => setSelectedBank((current) => ({ ...current, [question.id]: event.target.checked }))}
                            className="mt-1"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 mb-1">
                              <span className="text-xs font-bold text-on-surface-variant">Q{index + 1}</span>
                              <span className="px-2 py-0.5 rounded-full bg-surface-container-high text-xs font-semibold text-on-surface-variant">{typeLabel[question.type] || asText(question.type)}</span>
                              <span className={`px-2 py-0.5 rounded-full text-xs font-semibold capitalize ${diffStyle[question.difficulty] || "bg-surface-container-high"}`}>{asText(question.difficulty)}</span>
                              <span className="px-2 py-0.5 rounded-full bg-surface-container-high text-xs font-semibold text-on-surface-variant">{question.points} pts</span>
                            </div>
                            <QuestionPrompt
                              prompt={question.prompt}
                              imageUrl={question.image_url}
                              className="space-y-2 text-sm font-semibold text-on-surface leading-6"
                              imageWrapperClassName="mt-3 rounded-lg border border-outline-variant bg-surface-container-low p-2"
                            />
                            <PreviewOptions question={question} options={question.options} answer={question.answer} compact />
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

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
              <section className="bg-white border border-outline-variant rounded-xl p-5 space-y-4">
                <div>
                  <h3 className="font-headline text-lg font-bold text-primary">Exam details</h3>
                  <p className="text-sm text-on-surface-variant">Review the complete question set below before saving or publishing.</p>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <label className="space-y-1 text-sm font-semibold text-on-surface">
                    Exam title
                    <input value={examTitle} onChange={(event) => setExamTitle(event.target.value)} placeholder="Enter an exam title"
                      className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary font-normal" />
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-on-surface">
                    Exam mode
                    <select value={examMode} onChange={(event) => setExamMode(event.target.value as "take_home" | "live")}
                      className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white font-normal">
                      <option value="take_home">Take-home quiz</option>
                      <option value="live">Live quiz</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm font-semibold text-on-surface">
                    Duration (minutes)
                    <input type="number" min={1} value={durationMin} onChange={(event) => setDurationMin(Math.max(1, Number(event.target.value)))}
                      className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white font-normal" />
                  </label>
                  {examMode === "take_home" && (
                    <label className="space-y-1 text-sm font-semibold text-on-surface">
                      Opens at (optional)
                      <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)}
                        className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white font-normal" />
                      <span className="block text-xs font-normal text-on-surface-variant">Leave blank to open immediately.</span>
                    </label>
                  )}
                  <label className="space-y-1 text-sm font-semibold text-on-surface">
                    Due date (optional)
                    <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)}
                      className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white font-normal" />
                  </label>
                  {examMode === "live" && (
                    <label className="space-y-1 text-sm font-semibold text-on-surface md:col-span-2">
                      Live access code
                      <input value={accessCode} onChange={(event) => setAccessCode(event.target.value)} placeholder="Enter an access code"
                        className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary font-normal" />
                    </label>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-outline-variant">
                  <span className="text-sm font-semibold text-on-surface">Question order</span>
                  <select value={orderMode} onChange={(event) => {
                    const mode = event.target.value as "current" | "type" | "shuffle";
                    if (mode === "shuffle") shuffleQuestions(); else setOrderMode(mode);
                  }} className="border border-outline-variant rounded-lg px-3 py-2 bg-white text-sm">
                    <option value="current">Current order</option>
                    <option value="type">Sort by question type</option>
                    <option value="shuffle">Shuffle questions</option>
                  </select>
                  {orderMode === "shuffle" && (
                    <button onClick={shuffleQuestions} disabled={orderedQuestions.length < 2}
                      className="border border-secondary text-secondary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
                      <Icon name="shuffle" className="text-[18px]" /> Shuffle again
                    </button>
                  )}
                  <span className="ml-auto text-sm text-on-surface-variant">{orderedQuestions.length} included questions</span>
                </div>
              </section>
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
                        <div className="flex justify-between gap-3">
                          <QuestionPrompt
                            prompt={draft.prompt}
                            imageUrl={question.image_url}
                            className="space-y-2 font-semibold text-on-surface leading-6"
                          />
                          <span className="text-xs text-on-surface-variant whitespace-nowrap">{draft.points} pts</span>
                        </div>
                        <PreviewOptions question={question} options={draft.options} answer={draft.answer} />
                      </div>
                    </div>
                  </article>
                </div>;
              })}
            </div>
            <div className="sticky bottom-0 bg-surface-container-lowest border-t border-outline-variant px-6 py-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-on-surface-variant">Choose whether students can access this exam immediately.</p>
              <div className="flex gap-3">
                <button onClick={() => setShowPreview(false)} disabled={createExam.isPending}
                  className="border border-outline-variant text-on-surface-variant px-5 py-2 rounded-lg font-semibold disabled:opacity-50">Cancel</button>
                <button onClick={() => createExam.mutate({ refs: orderedRefs, publish: false })}
                  disabled={createExam.isPending || !examTitle.trim() || (examMode === "live" && !accessCode.trim())}
                  className="border border-primary text-primary px-5 py-2 rounded-lg font-semibold disabled:opacity-50">Save as draft</button>
                <button onClick={() => createExam.mutate({ refs: orderedRefs, publish: true })}
                  disabled={createExam.isPending || !examTitle.trim() || (examMode === "live" && !accessCode.trim())}
                  className="bg-primary text-on-primary px-6 py-2 rounded-lg font-semibold disabled:opacity-50">
                  {createExam.isPending ? "Creating..." : "Create and publish"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
  return embedded ? content : <Layout title="Review Questions">{content}</Layout>;
}

function QuestionImage({ imageUrl, compact = false }: { imageUrl?: string | null; compact?: boolean }) {
  if (!imageUrl) return null;
  return (
    <div className={`${compact ? "mt-3" : "mt-4"} rounded-lg border border-outline-variant bg-surface-container-low p-2`}>
      <img
        src={imageUrl}
        alt="Question diagram"
        className="max-h-72 w-full rounded-md object-contain"
      />
    </div>
  );
}

function QuestionImageEditor({ question, uploading, removing, onUpload, onInsert, onRemove }: {
  question: Question;
  uploading: boolean;
  removing: boolean;
  onUpload: (file: File) => void;
  onInsert: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Question image / diagram</p>
          <p className="text-xs text-on-surface-variant mt-1">Optional. Use this for figures, circuits, graphs, automata diagrams, or tables.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-secondary px-3 py-2 text-sm font-semibold text-secondary hover:bg-secondary-container/30">
            <Icon name="image" className="text-[18px]" />
            {question.image_url ? "Replace image" : "Attach image"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={uploading}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onUpload(file);
                event.target.value = "";
              }}
            />
          </label>
          {question.image_url && (
            <button
              type="button"
              onClick={onInsert}
              className="inline-flex items-center gap-2 rounded-lg border border-primary px-3 py-2 text-sm font-semibold text-primary hover:bg-primary-container/20"
            >
              <Icon name="add_photo_alternate" className="text-[18px]" /> Insert in text
            </button>
          )}
          {question.image_url && (
            <button
              type="button"
              onClick={onRemove}
              disabled={removing}
              className="inline-flex items-center gap-2 rounded-lg border border-error px-3 py-2 text-sm font-semibold text-error hover:bg-error-container disabled:opacity-50"
            >
              <Icon name="delete" className="text-[18px]" /> Remove
            </button>
          )}
        </div>
      </div>
      <QuestionImage imageUrl={question.image_url} compact />
    </div>
  );
}

function PreviewOptions({ question, options, answer, compact = false }: { question: Question; options: any; answer?: any; compact?: boolean }) {
  if (question.type === "mcq" && Array.isArray(options)) {
    const correct = Number(answer?.correct_index);
    return (
      <div className={`grid sm:grid-cols-2 gap-2 ${compact ? "mt-3" : "mt-4"}`}>
        {options.map((option, index) => {
          const isCorrect = correct === index;
          return (
            <div key={index} className={`border rounded-lg px-3 py-2 text-sm flex gap-2 ${isCorrect ? "border-secondary bg-secondary-container/30 text-secondary font-semibold" : "border-outline-variant text-on-surface-variant"}`}>
              <span className="font-bold">{String.fromCharCode(65 + index)}.</span>
              <span className="flex-1">{asText(option)}</span>
              {isCorrect && <span className="text-[10px] uppercase tracking-wide font-bold">Correct</span>}
            </div>
          );
        })}
      </div>
    );
  }
  if (question.type === "true_false") {
    const correct = answer?.correct === true;
    return (
      <div className={`flex gap-2 ${compact ? "mt-3" : "mt-4"}`}>
        {[true, false].map((value) => (
          <span key={String(value)} className={`border rounded-lg px-5 py-2 text-sm ${correct === value ? "border-secondary bg-secondary-container/30 text-secondary font-semibold" : "border-outline-variant text-on-surface-variant"}`}>
            {value ? "True" : "False"}{correct === value ? " - Correct" : ""}
          </span>
        ))}
      </div>
    );
  }
  if (question.type === "matching" && options?.left && options?.right) {
    const left = Array.isArray(options.left) ? options.left : [];
    const right = Array.isArray(options.right) ? options.right : [];
    const pairs: number[][] = Array.isArray(answer?.pairs) ? answer.pairs : [];
    return (
      <div className={`${compact ? "mt-3" : "mt-4"} space-y-3 text-sm`}>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">{left.map((item: unknown, index: number) => <p key={index} className="bg-surface-container-low rounded px-3 py-2">{index + 1}. {asText(item)}</p>)}</div>
          <div className="space-y-1">{right.map((item: unknown, index: number) => <p key={index} className="bg-surface-container-low rounded px-3 py-2">{String.fromCharCode(65 + index)}. {asText(item)}</p>)}</div>
        </div>
        {pairs.length > 0 && (
          <div className="rounded-lg border border-secondary bg-secondary-container/20 p-3 text-secondary">
            <p className="text-xs uppercase font-bold tracking-wide mb-2">Correct pairs</p>
            <div className="space-y-1">
              {pairs.map(([leftIndex, rightIndex], index) => (
                <p key={index}>{asText(left[leftIndex])} {"->"} {asText(right[rightIndex])}</p>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  if (question.type === "fill_blank" || question.type === "short_answer") {
    const accepted = Array.isArray(answer?.accepted) ? answer.accepted.map(asText).join(", ") : asText(answer?.accepted || answer?.text || answer);
    return <p className={`${compact ? "mt-3" : "mt-4"} rounded-lg border border-secondary bg-secondary-container/20 px-3 py-2 text-sm text-secondary font-semibold`}>Correct answer: {accepted || "Not set"}</p>;
  }
  if (question.type === "essay") {
    return <p className={`${compact ? "mt-3" : "mt-4"} rounded-lg border border-outline-variant bg-surface-container-low px-3 py-2 text-sm text-on-surface-variant`}>Rubric: {asText(answer?.rubric || answer) || "Not set"}</p>;
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
