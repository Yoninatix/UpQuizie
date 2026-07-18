import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api } from "../api";

interface Submission {
  attempt_id: string;
  exam_title: string;
  exam_mode: "take_home" | "live";
  subject: string;
  student_name: string;
  identifier: string;
  status: string;
  score: number | null;
  total_points: number | null;
  submitted_at: string | null;
}

interface ReviewAnswer {
  answer_id: string | null;
  question_id: string;
  position: number;
  type: string;
  prompt: string;
  options: any;
  expected_answer: any;
  points: number;
  response: any;
  awarded_points: number | null;
  is_correct: boolean | null;
  feedback: string | null;
}

interface Review extends Submission {
  attempt_id: string;
  answers: ReviewAnswer[];
}

const typeName: Record<string, string> = {
  mcq: "Multiple choice",
  true_false: "True / False",
  fill_blank: "Fill in the blank",
  matching: "Matching",
  essay: "Essay",
};

function text(value: any): string {
  if (value == null) return "No answer";
  if (typeof value === "string") return value;
  if (value.text != null) return String(value.text || "No answer");
  if (value.value != null) return String(value.value);
  if (value.index != null) return `Choice ${Number(value.index) + 1}`;
  return JSON.stringify(value);
}

function optionText(options: any, index: any): string {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0) return "No answer";
  if (Array.isArray(options) && options[i] != null) {
    return `${String.fromCharCode(65 + i)}. ${String(options[i])}`;
  }
  return `Choice ${i + 1}`;
}

function matchingPairs(options: any, pairs: any): string | null {
  const left = options?.left;
  const right = options?.right;
  if (!Array.isArray(pairs) || !Array.isArray(left) || !Array.isArray(right)) return null;
  return pairs
    .map((pair: any) => `${left[pair?.[0]] ?? `#${pair?.[0]}`} -> ${right[pair?.[1]] ?? `#${pair?.[1]}`}`)
    .join("\n");
}

function formatExpected(answer: ReviewAnswer): string {
  const expected = answer.expected_answer;
  if (expected == null) return "-";
  switch (answer.type) {
    case "mcq":
      return optionText(answer.options, expected.correct_index ?? 0);
    case "true_false":
      return expected.correct ? "True" : "False";
    case "fill_blank":
      return Array.isArray(expected.accepted) && expected.accepted.length > 0 ? expected.accepted.join(", ") : text(expected);
    case "matching":
      return matchingPairs(answer.options, expected.pairs) ?? text(expected);
    case "essay":
      return expected.rubric ? String(expected.rubric) : "Graded against the rubric / AI similarity.";
    default:
      return text(expected);
  }
}

function formatResponse(answer: ReviewAnswer): string {
  const response = answer.response;
  if (response == null || (typeof response === "object" && Object.keys(response).length === 0)) return "No answer";
  switch (answer.type) {
    case "mcq":
      return response.index != null ? optionText(answer.options, response.index) : "No answer";
    case "true_false":
      return response.value != null ? (response.value ? "True" : "False") : "No answer";
    case "fill_blank":
    case "essay":
      return typeof response.text === "string" && response.text.trim() !== "" ? response.text : "No answer";
    case "matching":
      return matchingPairs(answer.options, response.pairs) ?? text(response);
    default:
      return text(response);
  }
}

interface ScoreReviewProps {
  embedded?: boolean;
  subjectId?: string;
}

export default function ScoreReview({ embedded = false, subjectId }: ScoreReviewProps = {}) {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [mode, setMode] = useState<"take_home" | "all">("take_home");

  const { data: submissions = [], isLoading } = useQuery({
    queryKey: ["grading-submissions", subjectId ?? "all"],
    queryFn: () => api.get<Submission[]>(`/grading/submissions${subjectId ? `?subject_id=${subjectId}` : ""}`),
  });

  const visible = submissions.filter((submission) => mode === "all" || submission.exam_mode === "take_home");
  const quizColumns = useMemo(() => {
    const seen = new Set<string>();
    return visible
      .map((submission) => submission.exam_title)
      .filter((title) => {
        if (seen.has(title)) return false;
        seen.add(title);
        return true;
      });
  }, [visible]);
  const gradebookRows = useMemo(() => {
    const rows = new Map<string, { name: string; identifier: string; submissions: Map<string, Submission> }>();
    for (const submission of visible) {
      const key = submission.identifier || submission.student_name;
      if (!rows.has(key)) {
        rows.set(key, { name: submission.student_name, identifier: submission.identifier, submissions: new Map() });
      }
      const row = rows.get(key)!;
      const existing = row.submissions.get(submission.exam_title);
      if (!existing || new Date(submission.submitted_at || 0).getTime() > new Date(existing.submitted_at || 0).getTime()) {
        row.submissions.set(submission.exam_title, submission);
      }
    }
    return Array.from(rows.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [visible]);

  useEffect(() => {
    if (!selectedId && visible[0]) setSelectedId(visible[0].attempt_id);
  }, [selectedId, visible]);

  const { data: review, isLoading: loadingReview } = useQuery({
    queryKey: ["attempt-review", selectedId],
    queryFn: () => api.get<Review>(`/attempts/${selectedId}/review`),
    enabled: !!selectedId,
  });

  const update = useMutation({
    mutationFn: ({ answerId, points, feedback }: { answerId: string; points: number; feedback: string }) =>
      api.patch(`/attempts/${selectedId}/answers/${answerId}`, { points, feedback }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attempt-review", selectedId] });
      qc.invalidateQueries({ queryKey: ["grading-submissions"] });
    },
  });

  const content = (
    <>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-6">
        <div>
          <h2 className="font-headline text-2xl font-bold text-primary">Student answers and score review</h2>
          <p className="text-on-surface-variant text-sm mt-1">Review submissions in rows, then correct scores directly in the answer table.</p>
        </div>
        <select
          value={mode}
          onChange={(event) => {
            setMode(event.target.value as "take_home" | "all");
            setSelectedId("");
          }}
          className="border border-outline-variant rounded-lg px-3 py-2 bg-white"
        >
          <option value="take_home">Take-home quizzes</option>
          <option value="all">All submissions</option>
        </select>
      </div>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden mb-6">
        <div className="px-5 py-4 border-b border-outline-variant flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-bold text-primary">Gradebook</p>
            <p className="text-xs text-on-surface-variant">{gradebookRows.length} student{gradebookRows.length === 1 ? "" : "s"} - {quizColumns.length} quiz column{quizColumns.length === 1 ? "" : "s"}</p>
          </div>
          {review && (
            <p className="text-sm font-semibold text-secondary">
              Selected: {review.student_name} - {review.score ?? 0}/{review.total_points ?? 0}
            </p>
          )}
        </div>
        <div className="overflow-auto max-h-[420px]">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-surface-container-low sticky top-0 z-10">
              <tr className="text-left text-xs uppercase tracking-wider text-on-surface-variant">
                <th className="px-4 py-3 font-bold sticky left-0 bg-surface-container-low z-20 min-w-[220px]">Student</th>
                <th className="px-4 py-3 font-bold min-w-[120px]">ID</th>
                {quizColumns.map((title) => (
                  <th key={title} className="px-4 py-3 font-bold min-w-[150px] max-w-[190px]">
                    <span className="block truncate" title={title}>{title}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant">
              {gradebookRows.map((row) => (
                <tr key={row.identifier || row.name} className="hover:bg-surface-container-low/70">
                  <td className="px-4 py-3 font-semibold text-on-surface whitespace-nowrap sticky left-0 bg-surface-container-lowest z-10">{row.name}</td>
                  <td className="px-4 py-3 text-on-surface-variant whitespace-nowrap">{row.identifier || "-"}</td>
                  {quizColumns.map((title) => {
                    const submission = row.submissions.get(title);
                    const selected = submission?.attempt_id === selectedId;
                    return (
                      <td key={title} className="px-4 py-3 whitespace-nowrap">
                        {submission ? (
                          <button
                            onClick={() => setSelectedId(submission.attempt_id)}
                            title={`${submission.student_name} - ${submission.exam_title}${submission.submitted_at ? ` - ${new Date(submission.submitted_at).toLocaleString()}` : ""}`}
                            className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${selected ? "border-secondary bg-secondary-container/50 text-secondary" : "border-outline-variant bg-white hover:border-secondary"}`}
                          >
                            <span className="block font-bold">{submission.score ?? 0}/{submission.total_points ?? 0}</span>
                            <span className={`block text-[10px] uppercase font-bold ${submission.status === "needs_review" ? "text-orange-700" : "text-green-700"}`}>{submission.status.replace("_", " ")}</span>
                          </button>
                        ) : (
                          <span className="text-on-surface-variant">-</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {!isLoading && gradebookRows.length === 0 && (
                <tr>
                  <td colSpan={Math.max(2 + quizColumns.length, 3)} className="px-4 py-8 text-center text-on-surface-variant">No submitted quizzes yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-outline-variant flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <p className="font-bold text-primary">Answer Review</p>
            <p className="text-xs text-on-surface-variant">
              {review ? `${review.exam_title} - ${review.student_name}${review.identifier ? ` (${review.identifier})` : ""}` : "Select a submission to review answers."}
            </p>
          </div>
          {review && (
            <div className="text-left md:text-right">
              <p className="text-xs uppercase tracking-widest text-on-surface-variant">Current score</p>
              <p className="text-2xl font-bold text-primary">{review.score ?? 0}<span className="text-base text-on-surface-variant">/{review.total_points ?? 0}</span></p>
            </div>
          )}
        </div>

        {loadingReview && <p className="p-6 text-on-surface-variant">Loading student answers...</p>}
        {review && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-sm">
              <thead className="bg-surface-container-low">
                <tr className="text-left text-xs uppercase tracking-wider text-on-surface-variant">
                  <th className="px-4 py-3 font-bold w-16">No.</th>
                  <th className="px-4 py-3 font-bold w-32">Type</th>
                  <th className="px-4 py-3 font-bold">Question</th>
                  <th className="px-4 py-3 font-bold">Student Answer</th>
                  <th className="px-4 py-3 font-bold">Correct / Rubric</th>
                  <th className="px-4 py-3 font-bold w-28">Points</th>
                  <th className="px-4 py-3 font-bold">Feedback</th>
                  <th className="px-4 py-3 font-bold w-28">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {review.answers.map((answer) => (
                  <AnswerRow
                    key={answer.question_id}
                    answer={answer}
                    saving={update.isPending}
                    onSave={(points, feedback) => answer.answer_id && update.mutate({ answerId: answer.answer_id, points, feedback })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );

  return embedded ? content : <Layout title="Grade Submissions">{content}</Layout>;
}

function AnswerRow({ answer, saving, onSave }: { answer: ReviewAnswer; saving: boolean; onSave: (points: number, feedback: string) => void }) {
  const [points, setPoints] = useState(answer.awarded_points ?? 0);
  const [feedback, setFeedback] = useState(answer.feedback || "");

  useEffect(() => {
    setPoints(answer.awarded_points ?? 0);
    setFeedback(answer.feedback || "");
  }, [answer.awarded_points, answer.feedback]);

  return (
    <tr className={answer.awarded_points == null ? "bg-orange-50/50" : "hover:bg-surface-container-low/60"}>
      <td className="px-4 py-3 align-top font-bold text-primary">{answer.position}</td>
      <td className="px-4 py-3 align-top text-on-surface-variant">{typeName[answer.type] || answer.type}</td>
      <td className="px-4 py-3 align-top min-w-[260px]">
        <p className="font-semibold text-on-surface leading-6">{answer.prompt}</p>
        <p className="text-xs text-on-surface-variant mt-2">{answer.points} possible point{answer.points === 1 ? "" : "s"}</p>
      </td>
      <td className="px-4 py-3 align-top min-w-[220px] whitespace-pre-line text-on-surface">{formatResponse(answer)}</td>
      <td className="px-4 py-3 align-top min-w-[220px] whitespace-pre-line text-green-800">{formatExpected(answer)}</td>
      <td className="px-4 py-3 align-top">
        <input
          type="number"
          min={0}
          max={answer.points}
          value={points}
          onChange={(event) => setPoints(Math.min(answer.points, Math.max(0, Number(event.target.value))))}
          className="w-20 border border-outline-variant rounded-lg px-3 py-2 bg-white text-on-surface"
        />
        <p className="text-xs text-on-surface-variant mt-1">/ {answer.points}</p>
      </td>
      <td className="px-4 py-3 align-top min-w-[260px]">
        <textarea
          rows={3}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder={answer.feedback || "Explain any score correction"}
          className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white text-on-surface resize-y"
        />
        {answer.feedback && (
          <p className="text-xs text-secondary mt-2 flex items-center gap-1">
            <Icon name="auto_awesome" className="text-[14px]" /> Auto feedback recorded
          </p>
        )}
      </td>
      <td className="px-4 py-3 align-top">
        <button
          onClick={() => onSave(points, feedback)}
          disabled={saving || !answer.answer_id}
          className="bg-secondary text-on-secondary px-4 py-2 rounded-lg font-semibold disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap"
        >
          <Icon name="save" className="text-[18px]" /> Save
        </button>
      </td>
    </tr>
  );
}
