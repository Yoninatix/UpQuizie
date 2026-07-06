import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api } from "../api";

interface Submission {
  attempt_id: string; exam_title: string; exam_mode: "take_home" | "live"; subject: string;
  student_name: string; identifier: string; status: string; score: number | null;
  total_points: number | null; submitted_at: string | null;
}
interface ReviewAnswer {
  answer_id: string | null; question_id: string; position: number; type: string; prompt: string;
  options: any; expected_answer: any; points: number; response: any;
  awarded_points: number | null; is_correct: boolean | null; feedback: string | null;
}
interface Review extends Submission { attempt_id: string; answers: ReviewAnswer[] }

const typeName: Record<string, string> = { mcq: "Multiple choice", true_false: "True / False", fill_blank: "Fill in the blank", matching: "Matching", essay: "Essay" };

function text(value: any): string {
  if (value == null) return "No answer";
  if (typeof value === "string") return value;
  if (value.text != null) return String(value.text || "No answer");
  if (value.value != null) return String(value.value);
  if (value.index != null) return `Choice ${Number(value.index) + 1}`;
  return JSON.stringify(value);
}

export default function ScoreReview() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [mode, setMode] = useState<"take_home" | "all">("take_home");
  const { data: submissions = [], isLoading } = useQuery({ queryKey: ["grading-submissions"], queryFn: () => api.get<Submission[]>("/grading/submissions") });
  const visible = submissions.filter((submission) => mode === "all" || submission.exam_mode === "take_home");
  useEffect(() => { if (!selectedId && visible[0]) setSelectedId(visible[0].attempt_id); }, [selectedId, visible]);
  const { data: review, isLoading: loadingReview } = useQuery({
    queryKey: ["attempt-review", selectedId], queryFn: () => api.get<Review>(`/attempts/${selectedId}/review`), enabled: !!selectedId,
  });
  const update = useMutation({
    mutationFn: ({ answerId, points, feedback }: { answerId: string; points: number; feedback: string }) =>
      api.patch(`/attempts/${selectedId}/answers/${answerId}`, { points, feedback }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attempt-review", selectedId] });
      qc.invalidateQueries({ queryKey: ["grading-submissions"] });
    },
  });

  return <Layout title="Grade Submissions">
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-6">
      <div><h2 className="font-headline text-2xl font-bold text-primary">Student answers and score review</h2><p className="text-on-surface-variant text-sm mt-1">Inspect automatic and AI-assisted scores, then correct points when needed.</p></div>
      <select value={mode} onChange={(event) => { setMode(event.target.value as "take_home" | "all"); setSelectedId(""); }} className="border border-outline-variant rounded-lg px-3 py-2 bg-white">
        <option value="take_home">Take-home quizzes</option><option value="all">All submissions</option>
      </select>
    </div>

    <div className="grid lg:grid-cols-[340px_1fr] gap-5 items-start">
      <aside className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden lg:sticky lg:top-20">
        <div className="px-5 py-4 border-b border-outline-variant"><p className="font-bold text-primary">Submissions</p><p className="text-xs text-on-surface-variant">{visible.length} submitted</p></div>
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-outline-variant">
          {visible.map((submission) => <button key={submission.attempt_id} onClick={() => setSelectedId(submission.attempt_id)}
            className={`w-full text-left p-4 transition-colors ${selectedId === submission.attempt_id ? "bg-secondary-container/50" : "hover:bg-surface-container-low"}`}>
            <div className="flex justify-between gap-2"><p className="font-semibold text-on-surface truncate">{submission.student_name}</p><span className={`text-[10px] uppercase font-bold ${submission.status === "needs_review" ? "text-orange-600" : "text-green-600"}`}>{submission.status.replace("_", " ")}</span></div>
            <p className="text-xs text-on-surface-variant truncate mt-1">{submission.exam_title}</p>
            <p className="text-sm font-bold text-primary mt-2">{submission.score ?? 0}/{submission.total_points ?? 0} points</p>
          </button>)}
          {!isLoading && visible.length === 0 && <p className="p-6 text-sm text-on-surface-variant text-center">No submitted quizzes yet.</p>}
        </div>
      </aside>

      <main>
        {loadingReview && <p className="text-on-surface-variant">Loading student answers…</p>}
        {review && <>
          <section className="bg-primary text-on-primary rounded-xl p-6 mb-5 flex flex-wrap items-center justify-between gap-5">
            <div><p className="text-xs uppercase tracking-widest opacity-70">{review.exam_mode.replace("_", " ")} submission</p><h3 className="font-headline text-2xl font-bold mt-1">{review.exam_title}</h3><p className="opacity-80 mt-1">{review.student_name}{review.identifier ? ` · ${review.identifier}` : ""}</p></div>
            <div className="text-right"><p className="text-xs uppercase tracking-widest opacity-70">Current score</p><p className="text-4xl font-bold">{review.score ?? 0}<span className="text-xl opacity-70">/{review.total_points ?? 0}</span></p></div>
          </section>
          <div className="space-y-4">
            {review.answers.map((answer) => <AnswerCard key={answer.question_id} answer={answer} saving={update.isPending}
              onSave={(points, feedback) => answer.answer_id && update.mutate({ answerId: answer.answer_id, points, feedback })} />)}
          </div>
        </>}
      </main>
    </div>
  </Layout>;
}

function AnswerCard({ answer, saving, onSave }: { answer: ReviewAnswer; saving: boolean; onSave: (points: number, feedback: string) => void }) {
  const [points, setPoints] = useState(answer.awarded_points ?? 0);
  const [feedback, setFeedback] = useState(answer.feedback || "");
  useEffect(() => { setPoints(answer.awarded_points ?? 0); setFeedback(answer.feedback || ""); }, [answer.awarded_points, answer.feedback]);
  return <article className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-4"><div><span className="text-xs uppercase tracking-wider text-secondary font-bold">Question {answer.position} · {typeName[answer.type] || answer.type}</span><h4 className="font-semibold text-on-surface mt-2 leading-6">{answer.prompt}</h4></div><span className="text-sm text-on-surface-variant whitespace-nowrap">{answer.points} pts</span></div>
      <div className="grid md:grid-cols-2 gap-3 mb-4">
        <div className="bg-surface-container-low rounded-lg p-4"><p className="text-[11px] uppercase font-bold tracking-wider text-on-surface-variant mb-2">Student answer</p><p className="text-sm font-semibold text-on-surface break-words">{text(answer.response)}</p></div>
        <div className="bg-green-50 border border-green-100 rounded-lg p-4"><p className="text-[11px] uppercase font-bold tracking-wider text-green-700 mb-2">Expected answer / rubric</p><p className="text-sm text-green-900 break-words">{text(answer.expected_answer)}</p></div>
      </div>
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex gap-3"><Icon name="auto_awesome" className="text-secondary shrink-0" /><div><p className="text-xs uppercase tracking-wider font-bold text-secondary">Automatic / AI grading explanation</p><p className="text-sm text-blue-900 mt-1">{answer.feedback || "No automated explanation was recorded. Teacher review is required."}</p></div></div>
    </div>
    <div className="bg-surface-container-low border-t border-outline-variant px-6 py-4 flex flex-col md:flex-row md:items-end gap-3">
      <label className="text-xs font-bold text-on-surface-variant">Awarded points<input type="number" min={0} max={answer.points} value={points} onChange={(event) => setPoints(Math.min(answer.points, Math.max(0, Number(event.target.value))))} className="block mt-1 w-24 border border-outline-variant rounded-lg px-3 py-2 bg-white text-on-surface" /></label>
      <label className="text-xs font-bold text-on-surface-variant flex-1">Teacher correction / feedback<input value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Explain any score correction" className="block mt-1 w-full border border-outline-variant rounded-lg px-3 py-2 bg-white text-on-surface" /></label>
      <button onClick={() => onSave(points, feedback)} disabled={saving || !answer.answer_id} className="bg-secondary text-on-secondary px-5 py-2.5 rounded-lg font-semibold disabled:opacity-50 flex items-center justify-center gap-2"><Icon name="save" /> Save score</button>
    </div>
  </article>;
}
