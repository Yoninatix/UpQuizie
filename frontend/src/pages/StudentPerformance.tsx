import { useQuery } from "@tanstack/react-query";
import Layout from "../components/Layout";
import { api } from "../api";

interface TopicMastery {
  topic: string; accuracy: number; weak: boolean; level: "weak" | "developing" | "mastered";
  earned_points: number; total_points: number;
}
interface Attempt {
  id: string; title: string; subject: string; score: number | null; total_points: number | null;
  status: string; topic_mastery: TopicMastery[]; weak_topics: TopicMastery[];
}
interface Perf { average_score: number | null; attempts: Attempt[]; topic_mastery: TopicMastery[]; weak_topics: TopicMastery[] }

export default function StudentPerformance() {
  const { data: perf } = useQuery({ queryKey: ["me-performance"], queryFn: () => api.get<Perf>("/me/performance") });
  const avg = perf?.average_score;
  const completed = (perf?.attempts || []).filter((attempt) => attempt.status !== "in_progress");
  const topics = perf?.topic_mastery || [];
  const weakTopics = perf?.weak_topics || [];

  return <Layout title="Performance">
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 mb-6">
      <Summary label="Average Score" value={avg != null ? `${avg.toFixed(1)}%` : "—"} tone="primary" />
      <Summary label="Exams Taken" value={String(completed.length)} tone="primary" />
      <Summary label="Mastered Topics" value={String(topics.filter((topic) => topic.level === "mastered").length)} tone="success" />
      <Summary label="Weak Topics" value={String(weakTopics.length)} tone="error" />
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6">
        <h3 className="font-headline text-lg text-primary">Overall Topic Mastery</h3>
        <p className="text-sm text-on-surface-variant mt-1 mb-5">Combined results from all quizzes you have taken.</p>
        <div className="space-y-5">
          {topics.map((topic) => <div key={topic.topic}>
            <div className="flex justify-between gap-3 text-sm mb-1"><span className="font-medium text-on-surface">{topic.topic}</span><span className={`font-bold capitalize ${topic.weak ? "text-error" : topic.level === "developing" ? "text-orange-600" : "text-secondary"}`}>{topic.accuracy.toFixed(0)}% · {topic.level}</span></div>
            <div className="w-full h-2.5 bg-surface-container rounded-full overflow-hidden"><div className={`h-full rounded-full ${topic.weak ? "bg-error" : topic.level === "developing" ? "bg-orange-500" : "bg-secondary"}`} style={{ width: `${topic.accuracy}%` }} /></div>
            <p className="text-[11px] text-on-surface-variant mt-1">{topic.earned_points}/{topic.total_points} points across all quizzes</p>
          </div>)}
          {topics.length === 0 && <p className="text-sm text-on-surface-variant">No graded topic data yet. Complete a quiz to see mastery and weak areas.</p>}
        </div>
      </section>

      <section className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6">
        <h3 className="font-headline text-lg text-primary">Weak Topics by Quiz</h3>
        <p className="text-sm text-on-surface-variant mt-1 mb-5">See topic mastery for each completed quiz.</p>
        <div className="space-y-3">
          {completed.map((attempt) => <article key={attempt.id} className="p-4 bg-surface-container-low rounded-lg">
            <div className="flex justify-between items-center gap-3">
              <div><p className="text-sm font-semibold text-primary">{attempt.title}</p><p className="text-xs text-on-surface-variant">{attempt.subject}</p></div>
              <span className="text-secondary font-bold">{attempt.score != null && attempt.total_points ? `${Math.round(attempt.score / attempt.total_points * 100)}%` : "—"}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(attempt.topic_mastery || []).map((topic) => <span key={topic.topic} className={`px-2.5 py-1 rounded-full text-xs font-semibold ${topic.weak ? "bg-error-container text-on-error-container" : topic.level === "developing" ? "bg-orange-100 text-orange-800" : "bg-green-100 text-green-800"}`}>{topic.topic}: {topic.accuracy.toFixed(0)}%</span>)}
              {(attempt.topic_mastery || []).length === 0 && <span className="text-xs text-on-surface-variant">Topic scores are pending grading.</span>}
            </div>
            {attempt.weak_topics?.length > 0
              ? <p className="text-xs text-error font-semibold mt-3">Weak in: {attempt.weak_topics.map((topic) => topic.topic).join(", ")}</p>
              : (attempt.topic_mastery || []).length > 0 && <p className="text-xs text-green-700 font-semibold mt-3">No weak topics detected in this quiz.</p>}
          </article>)}
          {completed.length === 0 && <p className="text-sm text-on-surface-variant">No completed quizzes yet.</p>}
        </div>
      </section>
    </div>
  </Layout>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone: "primary" | "success" | "error" }) {
  const color = tone === "success" ? "text-secondary" : tone === "error" ? "text-error" : "text-primary";
  return <div className={`${tone === "primary" && label === "Average Score" ? "bg-primary text-on-primary" : "bg-surface-container-lowest border border-outline-variant"} rounded-xl p-6`}><p className={`text-sm ${tone === "primary" && label === "Average Score" ? "opacity-80" : "text-on-surface-variant"}`}>{label}</p><p className={`font-headline text-4xl font-bold mt-2 ${tone === "primary" && label === "Average Score" ? "" : color}`}>{value}</p></div>;
}
