import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Exam } from "../api";

interface Attempt {
  id: string; exam_id: string; status: string;
}
interface Performance { attempts: Attempt[] }

export default function StudentCalendar() {
  const nav = useNavigate();
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const { data: exams = [] } = useQuery({ queryKey: ["exams"], queryFn: () => api.get<Exam[]>("/exams") });
  const { data: performance } = useQuery({ queryKey: ["me-performance"], queryFn: () => api.get<Performance>("/me/performance") });
  const attemptByExam = new Map((performance?.attempts || []).map((attempt) => [attempt.exam_id, attempt]));
  const scheduled = exams.filter((exam) => exam.status === "published").map((exam) => {
    const attempt = attemptByExam.get(exam.id);
    const finished = !!attempt && attempt.status !== "in_progress";
    const missing = !finished && !!exam.due_at && new Date(exam.due_at).getTime() < Date.now();
    return { exam, attempt, state: finished ? "finished" : missing ? "missing" : "upcoming" } as const;
  }).sort((a, b) => (a.exam.due_at ? new Date(a.exam.due_at).getTime() : Infinity) - (b.exam.due_at ? new Date(b.exam.due_at).getTime() : Infinity));
  const firstWeekday = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: Math.ceil((firstWeekday + daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day > 0 && day <= daysInMonth ? day : null;
  });

  return <Layout title="Exam Calendar">
    <section className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
      <div className="px-6 py-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
        <div><h1 className="font-headline text-2xl text-primary">Exam Calendar</h1><p className="text-sm text-on-surface-variant">Deadlines for exams in your enrolled subjects.</p></div>
        <div className="flex items-center gap-2">
          <button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="p-2 rounded-lg hover:bg-surface-container-high"><Icon name="chevron_left" /></button>
          <span className="font-semibold text-primary min-w-36 text-center">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</span>
          <button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="p-2 rounded-lg hover:bg-surface-container-high"><Icon name="chevron_right" /></button>
        </div>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-7 text-center text-xs font-bold uppercase text-on-surface-variant mb-2">{["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((day) => <div key={day} className="py-2">{day}</div>)}</div>
        <div className="grid grid-cols-7 border-l border-t border-outline-variant">
          {cells.map((day, index) => {
            const items = day ? scheduled.filter(({ exam }) => exam.due_at && new Date(exam.due_at).getFullYear() === month.getFullYear() && new Date(exam.due_at).getMonth() === month.getMonth() && new Date(exam.due_at).getDate() === day) : [];
            return <div key={index} className="min-h-24 border-r border-b border-outline-variant p-2 bg-white">
              {day && <span className="text-xs font-semibold text-on-surface-variant">{day}</span>}
              <div className="space-y-1 mt-1">{items.map(({ exam, state }) => <div key={exam.id} className={`rounded px-1.5 py-1 text-[11px] font-semibold truncate ${state === "finished" ? "bg-surface-container-high text-on-surface-variant line-through" : state === "missing" ? "bg-error-container text-error" : "bg-secondary-container text-on-secondary-container"}`}>{exam.title}</div>)}</div>
            </div>;
          })}
        </div>
      </div>
      <div className="divide-y divide-outline-variant border-t border-outline-variant">
        {scheduled.map(({ exam, attempt, state }) => <div key={exam.id} className="p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div><h2 className={`font-semibold text-primary ${state === "finished" ? "line-through opacity-60" : ""}`}>{exam.title}</h2><p className="text-sm text-on-surface-variant">{exam.subject} · {exam.due_at ? `Due ${new Date(exam.due_at).toLocaleString()}` : "No deadline set"}</p></div>
          <div className="flex items-center gap-3"><span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${state === "finished" ? "bg-surface-container-high text-on-surface-variant line-through" : state === "missing" ? "bg-error-container text-error" : "bg-secondary-container text-on-secondary-container"}`}>{state}</span>{state === "finished" && attempt ? <button onClick={() => nav(`/attempts/${attempt.id}/results`)} className="text-secondary text-sm font-semibold">Results</button> : state === "upcoming" ? <button onClick={() => nav(`/exams/${exam.id}/take`)} className="bg-secondary text-on-secondary px-4 py-2 rounded-lg text-sm font-semibold">Start</button> : null}</div>
        </div>)}
        {scheduled.length === 0 && <p className="p-6 text-on-surface-variant">No exams scheduled right now.</p>}
      </div>
    </section>
  </Layout>;
}
