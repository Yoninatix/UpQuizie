import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import QuestionPrompt from "../components/QuestionPrompt";
import { api, Exam, Question, Subject } from "../api";
import { useAuth } from "../auth";
import ScoreReview from "./ScoreReview";

type QuestionDraft = {
  prompt: string;
  points: number;
  options: any;
  answer: any;
};

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

function toDateTimeLocal(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

export default function SubjectDetail() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [previewId, setPreviewId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [examDraft, setExamDraft] = useState({ title: "", duration_min: 60, starts_at: "", due_at: "" });
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [editMsg, setEditMsg] = useState("");

  const { data: subjects = [] } = useQuery({
    queryKey: ["subjects"],
    queryFn: () => api.get<Subject[]>("/subjects"),
  });
  const { data: exams = [], isLoading } = useQuery({
    queryKey: ["exams"],
    queryFn: () => api.get<Exam[]>("/exams"),
  });
  const { data: questions = [], isLoading: previewLoading } = useQuery({
    queryKey: ["exam-questions", previewId],
    queryFn: () => api.get<Question[]>(`/exams/${previewId}/questions`),
    enabled: !!previewId,
  });

  const canManage = user?.role === "educator" || user?.role === "admin";
  const tab = searchParams.get("tab") === "grading" && canManage ? "grading" : "quizzes";
  const subject = subjects.find((item) => item.id === id);
  const subjectExams = exams.filter((exam) => exam.subject_id === id);
  const published = subjectExams.filter((exam) => exam.status === "published");
  const visibleExams = canManage ? subjectExams : published;
  const activation = useMutation({
    mutationFn: ({ examId, active }: { examId: string; active: boolean }) => api.post(`/exams/${examId}/activation`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exams"] }),
  });
  const remove = useMutation({
    mutationFn: (examId: string) => api.del(`/exams/${examId}`),
    onSuccess: (_, examId) => {
      if (previewId === examId) setPreviewId("");
      qc.invalidateQueries({ queryKey: ["exams"] });
      qc.invalidateQueries({ queryKey: ["subjects"] });
    },
  });
  const saveExam = useMutation({
    mutationFn: ({ examId }: { examId: string }) => api.patch(`/exams/${examId}`, {
      title: examDraft.title,
      duration_min: Number(examDraft.duration_min) || 1,
      starts_at: examDraft.starts_at ? new Date(examDraft.starts_at).toISOString() : null,
      due_at: examDraft.due_at ? new Date(examDraft.due_at).toISOString() : null,
    }),
    onSuccess: (_, variables) => {
      setEditMsg("Exam details saved.");
      qc.invalidateQueries({ queryKey: ["exams"] });
      qc.invalidateQueries({ queryKey: ["exam-questions", variables.examId] });
    },
    onError: (error: Error) => setEditMsg(`Save failed: ${error.message}`),
  });
  const saveQuestion = useMutation({
    mutationFn: ({ questionId }: { questionId: string; examId: string }) => {
      const draft = questionDrafts[questionId];
      return api.patch(`/exam-questions/${questionId}`, {
        prompt: draft.prompt,
        points: Number(draft.points) || 1,
        options: draft.options,
        answer: draft.answer,
      });
    },
    onSuccess: (_, variables) => {
      setEditMsg("Question saved.");
      qc.invalidateQueries({ queryKey: ["exams"] });
      qc.invalidateQueries({ queryKey: ["exam-questions", variables.examId] });
    },
    onError: (error: Error) => setEditMsg(`Question save failed: ${error.message}`),
  });

  const beginEdit = (exam: Exam, qs: Question[]) => {
    setEditingId(exam.id);
    setEditMsg("");
    setExamDraft({
      title: exam.title,
      duration_min: exam.duration_min,
      starts_at: toDateTimeLocal(exam.starts_at),
      due_at: toDateTimeLocal(exam.due_at),
    });
    setQuestionDrafts(Object.fromEntries(qs.map((question) => [
      question.id,
      { prompt: String(question.prompt || ""), points: question.points || 1, options: question.options ?? null, answer: question.answer ?? {} },
    ])));
  };

  return (
    <Layout title={subject?.name || "Subject"}>
      <button onClick={() => nav("/subjects")}
        className="flex items-center gap-1 text-secondary text-sm font-semibold mb-5 hover:underline">
        <Icon name="arrow_back" className="text-[18px]" /> Back to Subjects
      </button>

      <section className="bg-primary text-on-primary rounded-2xl p-7 mb-6 flex flex-col md:flex-row md:items-center justify-between gap-5">
        <div>
          <span className="text-xs font-bold uppercase tracking-widest opacity-75">{subject?.code}</span>
          <h1 className="font-headline text-3xl font-bold mt-1">{subject?.name || "Subject"}</h1>
          <p className="mt-2 opacity-80">{subject?.department || "Published quizzes and learning materials"}</p>
        </div>
        <div className="flex gap-3">
          <div className="bg-white/10 rounded-xl px-5 py-3 text-center">
            <p className="text-2xl font-bold">{published.length}</p>
            <p className="text-xs uppercase tracking-wide opacity-75">Published quizzes</p>
          </div>
          <div className="bg-white/10 rounded-xl px-5 py-3 text-center">
            <p className="text-2xl font-bold">{subject?.students || 0}</p>
            <p className="text-xs uppercase tracking-wide opacity-75">Students</p>
          </div>
        </div>
      </section>

      <div className="flex items-center gap-1 border-b border-outline-variant mb-7">
        <button onClick={() => setSearchParams({})}
          className={`inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 font-semibold border-b-2 transition-colors ${tab === "quizzes" ? "border-secondary text-secondary" : "border-transparent text-on-surface-variant hover:text-secondary"}`}>
          <Icon name="quiz" className="text-[20px]" /> {canManage ? "Subject Quizzes" : "Published Quizzes"}
        </button>
        {canManage && (
          <button onClick={() => setSearchParams({ tab: "grading" })}
            className={`inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 font-semibold border-b-2 transition-colors ${tab === "grading" ? "border-secondary text-secondary" : "border-transparent text-on-surface-variant hover:text-secondary"}`}>
            <Icon name="fact_check" className="text-[20px]" /> Grade Submissions
          </button>
        )}
        {canManage && (
          <Link to={`/subjects/${id}/materials`}
            className="inline-flex items-center gap-2 whitespace-nowrap px-5 py-3 border-b-2 border-transparent text-on-surface-variant font-semibold transition-colors hover:text-secondary">
            <Icon name="folder_open" className="text-[20px]" /> Materials
          </Link>
        )}
        {canManage && (
          <Link to="/educator" className="ml-auto px-4 py-2 text-sm text-secondary font-semibold flex items-center gap-1 hover:underline">
            <Icon name="auto_awesome" className="text-[18px]" /> Generate & review
          </Link>
        )}
      </div>

      {tab === "grading" && canManage ? (
        <ScoreReview embedded subjectId={id} />
      ) : isLoading ? (
        <p className="text-on-surface-variant">Loading quizzes...</p>
      ) : visibleExams.length === 0 ? (
        <div className="border border-dashed border-outline-variant bg-surface-container-lowest rounded-2xl p-12 text-center">
          <div className="w-14 h-14 mx-auto rounded-full bg-surface-container-high flex items-center justify-center mb-4">
            <Icon name="quiz" className="text-3xl text-on-surface-variant" />
          </div>
          <h2 className="font-headline text-xl text-primary">No published quizzes yet</h2>
          <p className="text-sm text-on-surface-variant mt-2">Published quizzes created by the teacher will appear here.</p>
          {canManage && <Link to="/educator" className="inline-block mt-5 bg-secondary text-on-secondary px-5 py-2.5 rounded-lg font-semibold">Create a quiz</Link>}
        </div>
      ) : (
        <div className="space-y-4">
          {visibleExams.map((exam) => {
            const open = previewId === exam.id;
            const endedLive = exam.exam_mode === "live" && exam.live_state === "ended";
            const nextActive = endedLive || exam.status !== "published";
            return (
              <article key={exam.id} className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
                <div className="p-6 flex flex-col md:flex-row md:items-center gap-5">
                  <div className="w-12 h-12 shrink-0 rounded-xl bg-secondary-container text-on-secondary-container flex items-center justify-center">
                    <Icon name="assignment" className="text-2xl" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="font-headline text-lg font-bold text-primary">{exam.title}</h2>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${exam.status === "published" ? "bg-green-100 text-green-800" : "bg-surface-container-high text-on-surface-variant"}`}>
                        {endedLive ? "Ended" : exam.status === "published" ? "Active" : "Deactivated"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm text-on-surface-variant">
                      <span className="flex items-center gap-1"><Icon name="schedule" className="text-[17px]" /> {exam.duration_min} minutes</span>
                      <span className="flex items-center gap-1"><Icon name="grade" className="text-[17px]" /> {exam.total_points} points</span>
                      {exam.starts_at && <span className="flex items-center gap-1"><Icon name="event" className="text-[17px]" /> Opens {new Date(exam.starts_at).toLocaleString()}</span>}
                      {exam.due_at && <span className="flex items-center gap-1"><Icon name="event_busy" className="text-[17px]" /> Due {new Date(exam.due_at).toLocaleString()}</span>}
                    </div>
                  </div>
                  {user?.role === "student" ? (
                    exam.starts_at && new Date(exam.starts_at).getTime() > Date.now() ? (
                      <button disabled className="bg-surface-container-high text-on-surface-variant px-5 py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2">
                        Opens later
                      </button>
                    ) : (
                      <Link to={`/exams/${exam.id}/take`} className="bg-secondary text-on-secondary px-5 py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2">
                        Take quiz <Icon name="arrow_forward" className="text-[19px]" />
                      </Link>
                    )
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setPreviewId(open ? "" : exam.id)}
                        className="border border-outline-variant px-4 py-2.5 rounded-lg font-semibold text-secondary flex items-center justify-center gap-2 hover:bg-surface-container-low">
                        <Icon name={open ? "visibility_off" : "visibility"} className="text-[19px]" /> {open ? "Close" : "Preview"}
                      </button>
                      {open && (
                        <button onClick={() => editingId === exam.id ? setEditingId("") : beginEdit(exam, questions)}
                          disabled={previewLoading}
                          className="border border-primary px-4 py-2.5 rounded-lg font-semibold text-primary flex items-center justify-center gap-2 disabled:opacity-50">
                          <Icon name="edit" className="text-[19px]" /> {editingId === exam.id ? "Done editing" : "Edit"}
                        </button>
                      )}
                      <button onClick={() => activation.mutate({ examId: exam.id, active: nextActive })}
                        disabled={activation.isPending}
                        className="border border-secondary px-4 py-2.5 rounded-lg font-semibold text-secondary flex items-center justify-center gap-2 disabled:opacity-50">
                        <Icon name={endedLive ? "restart_alt" : exam.status === "published" ? "pause_circle" : "play_circle"} className="text-[19px]" />
                        {endedLive ? "Reset lobby" : exam.status === "published" ? "Deactivate" : "Activate"}
                      </button>
                      <button onClick={() => {
                        if (confirm(`Delete quiz \"${exam.title}\"? All student attempts and results for it will also be deleted. This cannot be undone.`)) remove.mutate(exam.id);
                      }} disabled={remove.isPending}
                        className="border border-error px-4 py-2.5 rounded-lg font-semibold text-error flex items-center justify-center gap-2 disabled:opacity-50">
                        <Icon name="delete" className="text-[19px]" /> Delete
                      </button>
                    </div>
                  )}
                </div>

                {open && (
                  <div className="border-t border-outline-variant bg-surface-container-low p-6">
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <h3 className="font-semibold text-primary">Quiz preview</h3>
                      {editingId === exam.id && (
                        <button onClick={() => saveExam.mutate({ examId: exam.id })}
                          disabled={saveExam.isPending || !examDraft.title.trim()}
                          className="bg-primary text-on-primary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
                          <Icon name="save" className="text-[18px]" /> Save exam details
                        </button>
                      )}
                    </div>
                    {editingId === exam.id && (
                      <div className="bg-white border border-outline-variant rounded-xl p-4 mb-4 grid md:grid-cols-2 gap-4">
                        <label className="text-sm font-semibold text-on-surface">
                          Exam title
                          <input value={examDraft.title} onChange={(event) => setExamDraft((draft) => ({ ...draft, title: event.target.value }))}
                            className="mt-1.5 w-full border border-outline-variant rounded-lg px-3 py-2 font-normal" />
                        </label>
                        <label className="text-sm font-semibold text-on-surface">
                          Duration (minutes)
                          <input type="number" min={1} value={examDraft.duration_min}
                            onChange={(event) => setExamDraft((draft) => ({ ...draft, duration_min: Math.max(1, Number(event.target.value)) }))}
                            className="mt-1.5 w-full border border-outline-variant rounded-lg px-3 py-2 font-normal" />
                        </label>
                        {exam.exam_mode === "take_home" && (
                          <label className="text-sm font-semibold text-on-surface">
                            Opens at
                            <input type="datetime-local" value={examDraft.starts_at}
                              onChange={(event) => setExamDraft((draft) => ({ ...draft, starts_at: event.target.value }))}
                              className="mt-1.5 w-full border border-outline-variant rounded-lg px-3 py-2 font-normal" />
                          </label>
                        )}
                        <label className="text-sm font-semibold text-on-surface">
                          Due date
                          <input type="datetime-local" value={examDraft.due_at}
                            onChange={(event) => setExamDraft((draft) => ({ ...draft, due_at: event.target.value }))}
                            className="mt-1.5 w-full border border-outline-variant rounded-lg px-3 py-2 font-normal" />
                        </label>
                        {editMsg && <p className="md:col-span-2 text-sm text-secondary">{editMsg}</p>}
                      </div>
                    )}
                    {previewLoading ? <p className="text-sm text-on-surface-variant">Loading questions...</p> : (
                      <div className="space-y-3">
                        {questions.map((question, index) => (
                          <div key={question.id} className="bg-white border border-outline-variant rounded-lg p-4">
                            <div className="flex justify-between gap-4 mb-2">
                              <span className="text-xs font-bold uppercase text-secondary">Question {index + 1} · {question.type.replace("_", " ")}</span>
                              {editingId === exam.id ? (
                                <input type="number" min={1} value={questionDrafts[question.id]?.points ?? question.points}
                                  onChange={(event) => setQuestionDrafts((drafts) => ({
                                    ...drafts,
                                    [question.id]: { ...(questionDrafts[question.id] || { prompt: String(question.prompt || ""), points: question.points || 1, options: question.options ?? null, answer: question.answer ?? {} }), points: Math.max(1, Number(event.target.value)) },
                                  }))}
                                  className="w-20 border border-outline-variant rounded px-2 py-1 text-xs text-right" />
                              ) : (
                                <span className="text-xs text-on-surface-variant">{question.points} pts</span>
                              )}
                            </div>
                            {editingId === exam.id ? (
                              <div className="space-y-3">
                                <textarea rows={2} value={questionDrafts[question.id]?.prompt ?? String(question.prompt || "")}
                                  onChange={(event) => setQuestionDrafts((drafts) => ({
                                    ...drafts,
                                    [question.id]: { ...(questionDrafts[question.id] || { prompt: String(question.prompt || ""), points: question.points || 1, options: question.options ?? null, answer: question.answer ?? {} }), prompt: event.target.value },
                                  }))}
                                  className="w-full border border-outline-variant rounded-lg p-3 text-sm" />
                                <PublishedAnswerEditor
                                  question={question}
                                  draft={questionDrafts[question.id] || { prompt: String(question.prompt || ""), points: question.points || 1, options: question.options ?? null, answer: question.answer ?? {} }}
                                  onChange={(patch) => setQuestionDrafts((drafts) => ({
                                    ...drafts,
                                    [question.id]: { ...(questionDrafts[question.id] || { prompt: String(question.prompt || ""), points: question.points || 1, options: question.options ?? null, answer: question.answer ?? {} }), ...patch },
                                  }))}
                                />
                                <button onClick={() => saveQuestion.mutate({ questionId: question.id, examId: exam.id })}
                                  disabled={saveQuestion.isPending || !questionDrafts[question.id]?.prompt?.trim()}
                                  className="border border-secondary text-secondary px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1 disabled:opacity-50">
                                  <Icon name="save" className="text-[16px]" /> Save question
                                </button>
                              </div>
                            ) : (
                              <div className="space-y-3">
                                <QuestionPrompt
                                  prompt={question.prompt}
                                  imageUrl={question.image_url}
                                  className="space-y-2 text-sm text-on-surface"
                                  imageWrapperClassName="rounded-lg border border-outline-variant bg-surface-container-low p-2"
                                />
                              </div>
                            )}
                          </div>
                        ))}
                        {questions.length === 0 && <p className="text-sm text-on-surface-variant">This quiz has no questions.</p>}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Layout>
  );
}

function PublishedAnswerEditor({ question, draft, onChange }: {
  question: Question;
  draft: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
}) {
  if (question.type === "mcq") {
    const options: string[] = Array.isArray(draft.options) ? draft.options.map(asText) : [];
    const correct = Number(draft.answer?.correct_index ?? 0);
    return (
      <div className="space-y-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Choices and correct answer</p>
        <div className="grid md:grid-cols-2 gap-2">
          {options.map((option, index) => (
            <label key={index} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${correct === index ? "border-secondary bg-secondary-container/30" : "border-outline-variant bg-white"}`}>
              <input
                type="radio"
                name={`published-answer-${question.id}`}
                checked={correct === index}
                onChange={() => onChange({ answer: { ...(draft.answer || {}), correct_index: index } })}
              />
              <span className="text-xs font-bold text-on-surface-variant">{String.fromCharCode(65 + index)}</span>
              <input
                value={option}
                onChange={(event) => {
                  const next = [...options];
                  next[index] = event.target.value;
                  onChange({ options: next });
                }}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none"
              />
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (question.type === "true_false") {
    const correct = draft.answer?.correct === true;
    return (
      <div className="space-y-2 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Correct answer</p>
        <div className="flex gap-2">
          {[true, false].map((value) => (
            <label key={String(value)} className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold ${correct === value ? "border-secondary bg-secondary-container/30 text-secondary" : "border-outline-variant bg-white"}`}>
              <input
                type="radio"
                name={`published-answer-${question.id}`}
                checked={correct === value}
                onChange={() => onChange({ answer: { correct: value }, options: ["True", "False"] })}
              />
              {value ? "True" : "False"}
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (question.type === "fill_blank") {
    const accepted = Array.isArray(draft.answer?.accepted) ? draft.answer.accepted.map(asText) : [];
    return (
      <label className="block rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <span className="block text-[11px] font-bold uppercase tracking-wider text-on-surface-variant mb-2">Accepted answer(s)</span>
        <input
          value={accepted.join(", ")}
          onChange={(event) => onChange({ answer: { accepted: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) } })}
          className="w-full rounded-lg border border-outline-variant bg-white px-3 py-2 text-sm"
        />
      </label>
    );
  }

  if (question.type === "essay") {
    return (
      <label className="block rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <span className="block text-[11px] font-bold uppercase tracking-wider text-on-surface-variant mb-2">Correct answer / rubric</span>
        <textarea
          rows={2}
          value={asText(draft.answer?.rubric ?? draft.answer)}
          onChange={(event) => onChange({ answer: { rubric: event.target.value } })}
          className="w-full rounded-lg border border-outline-variant bg-white px-3 py-2 text-sm"
        />
      </label>
    );
  }

  if (question.type === "matching") {
    const left: string[] = Array.isArray(draft.options?.left) ? draft.options.left.map(asText) : [];
    const right: string[] = Array.isArray(draft.options?.right) ? draft.options.right.map(asText) : [];
    const pairs: number[][] = Array.isArray(draft.answer?.pairs) ? draft.answer.pairs : [];
    return (
      <div className="space-y-3 rounded-lg border border-outline-variant bg-surface-container-low p-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Matching choices and correct pairs</p>
        <div className="grid md:grid-cols-2 gap-3">
          <ChoiceList title="Left choices" items={left} onChange={(items) => onChange({ options: { ...(draft.options || {}), left: items } })} />
          <ChoiceList title="Right choices" items={right} onChange={(items) => onChange({ options: { ...(draft.options || {}), right: items } })} />
        </div>
        <div className="space-y-2">
          {left.map((item, leftIndex) => {
            const current = pairs.find(([l]) => l === leftIndex)?.[1] ?? "";
            return (
              <label key={leftIndex} className="grid md:grid-cols-[1fr_160px] gap-2 items-center text-sm">
                <span className="truncate">{leftIndex + 1}. {item}</span>
                <select
                  value={current}
                  onChange={(event) => {
                    const next = pairs.filter(([l]) => l !== leftIndex);
                    if (event.target.value !== "") next.push([leftIndex, Number(event.target.value)]);
                    onChange({ answer: { pairs: next.sort((a, b) => a[0] - b[0]) } });
                  }}
                  className="rounded-lg border border-outline-variant bg-white px-3 py-2"
                >
                  <option value="">No match</option>
                  {right.map((_, rightIndex) => (
                    <option key={rightIndex} value={rightIndex}>{String.fromCharCode(65 + rightIndex)}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </div>
    );
  }

  return null;
}

function ChoiceList({ title, items, onChange }: { title: string; items: string[]; onChange: (items: string[]) => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-on-surface-variant">{title}</p>
      {items.map((item, index) => (
        <input
          key={index}
          value={item}
          onChange={(event) => {
            const next = [...items];
            next[index] = event.target.value;
            onChange(next);
          }}
          className="w-full rounded-lg border border-outline-variant bg-white px-3 py-2 text-sm"
        />
      ))}
    </div>
  );
}
