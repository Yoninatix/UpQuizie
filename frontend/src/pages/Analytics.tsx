import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Exam, Subject } from "../api";

interface AnalyticsData {
  topics: { topic: string; correct: number; total: number; accuracy: number; weak: boolean }[];
  average_score: number | null;
}

export default function Analytics() {
  const [subjectId, setSubjectId] = useState("");
  const { data: subjects = [] } = useQuery({ queryKey: ["subjects"], queryFn: () => api.get<Subject[]>("/subjects") });
  const { data: exams = [] } = useQuery({ queryKey: ["exams"], queryFn: () => api.get<Exam[]>("/exams") });
  const sid = subjectId || subjects[0]?.id || "";
  const { data } = useQuery({
    queryKey: ["analytics", sid],
    queryFn: () => api.get<AnalyticsData>(`/subjects/${sid}/analytics`),
    enabled: !!sid,
  });
  const topics = data?.topics || [];
  const weak = topics.filter((t) => t.weak);
  const recentExams = exams.filter((exam) => !sid || exam.subject_id === sid).slice(0, 5);

  return (
    <Layout title="Analytics Dashboard">
      <div className="flex items-center justify-between mb-6">
        <p className="text-on-surface-variant">Performance analytics from student exam submissions.</p>
        <select value={sid} onChange={(e) => setSubjectId(e.target.value)} className="border border-outline-variant rounded-lg px-3 py-2 bg-white">
          {subjects.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
        </select>
      </div>

      <h3 className="font-headline text-lg text-primary mb-3 flex items-center gap-2">
        <Icon name="trending_up" className="text-secondary" /> Quick Student Performance
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
        <Card label="Average Score" value={data?.average_score != null ? `${data.average_score.toFixed(1)}%` : "—"} icon="trending_up" />
        <Card label="Tracked Topics" value={`${topics.length}`} icon="topic" />
        <Card label="Weak Topics" value={`${weak.length}`} icon="warning" danger />
        <div className="bg-primary text-on-primary rounded-xl p-6">
          <div className="flex justify-between items-start mb-2"><span className="text-sm opacity-80">AI Insight</span><Icon name="auto_awesome" /></div>
          <p className="text-sm leading-relaxed">
            {weak[0] ? `Students are struggling most with “${weak[0].topic}”. Consider review material.` : "No weak areas detected yet."}
          </p>
        </div>
      </div>

      {/* Recent exams */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-outline-variant flex justify-between items-center">
          <h3 className="font-headline text-lg text-primary">Recent Exams</h3>
          <Link to="/exams" className="text-secondary text-sm font-semibold hover:underline">View all exams</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead><tr className="bg-surface-container-low text-xs text-outline">
              <th className="px-6 py-3">Exam Title</th><th className="px-6 py-3">Subject</th><th className="px-6 py-3">Points</th><th className="px-6 py-3">Status</th>
            </tr></thead>
            <tbody className="divide-y divide-outline-variant">
              {recentExams.map((exam) => (
                <tr key={exam.id}>
                  <td className="px-6 py-4 font-medium text-on-surface">{exam.title}</td>
                  <td className="px-6 py-4 text-on-surface-variant text-sm">{exam.subject}</td>
                  <td className="px-6 py-4 text-on-surface-variant text-sm">{exam.total_points}</td>
                  <td className="px-6 py-4"><span className="bg-secondary-container text-on-secondary-container px-3 py-1 rounded-full text-xs font-semibold capitalize">{exam.status}</span></td>
                </tr>
              ))}
              {recentExams.length === 0 && <tr><td colSpan={4} className="px-6 py-5 text-on-surface-variant">No exams yet for this subject.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Topic mastery (real) */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-headline text-lg text-primary">Topic Mastery &amp; Weak-Topic Detection</h3>
          <div className="flex gap-4 text-xs text-on-surface-variant">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-secondary" /> Strong</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-error" /> Weak (&lt;60%)</span>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-5">
          {topics.map((t) => (
            <div key={t.topic}>
              <div className="flex justify-between text-sm mb-1">
                <span className="font-medium text-on-surface flex items-center gap-2">
                  {t.weak && <Icon name="warning" className="text-error text-[18px]" />}{t.topic}
                </span>
                <span className={t.weak ? "text-error font-bold" : "text-secondary font-bold"}>
                  {t.accuracy.toFixed(0)}% ({t.correct}/{t.total})
                </span>
              </div>
              <div className="w-full h-2.5 bg-surface-container rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${t.weak ? "bg-error" : "bg-secondary"}`} style={{ width: `${t.accuracy}%` }} />
              </div>
            </div>
          ))}
        </div>
        {topics.length === 0 && (
          <p className="text-on-surface-variant py-6 text-center">
            No analytics yet. Data appears here once students submit exams for this subject.
          </p>
        )}
      </div>
    </Layout>
  );
}

function Card({ label, value, icon, danger }: { label: string; value: string; icon: string; danger?: boolean }) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6">
      <div className="flex justify-between items-start mb-2">
        <span className="text-on-surface-variant text-sm">{label}</span>
        <Icon name={icon} className={danger ? "text-error" : "text-secondary"} />
      </div>
      <p className="font-headline text-3xl font-bold text-primary">{value}</p>
    </div>
  );
}
