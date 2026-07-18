import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Exam } from "../api";
import { useAuth } from "../auth";

interface Perf {
  attempts: { id: string; title: string; subject: string; score: number | null; total_points: number | null; status: string }[];
}

export default function ExamsList() {
  const { user } = useAuth();
  const nav = useNavigate();
  const isStudent = user?.role === "student";
  const [tab, setTab] = useState<"active" | "completed">("active");

  const { data: exams = [] } = useQuery({ queryKey: ["exams"], queryFn: () => api.get<Exam[]>("/exams") });
  const { data: perf } = useQuery({ queryKey: ["me-performance"], queryFn: () => api.get<Perf>("/me/performance"), enabled: isStudent });

  const active = exams.filter((e) => e.status === "published");
  const completed = perf?.attempts.filter((a) => a.status !== "in_progress") || [];

  // Educator/admin: simple grid of all exams.
  if (!isStudent) {
    return (
      <Layout title="Exams">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {exams.map((e) => <ExamCard key={e.id} e={e} />)}
          {exams.length === 0 && <p className="text-on-surface-variant">No exams yet.</p>}
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="My Exams">
      <div className="mb-6">
        <h2 className="font-headline text-2xl text-primary">My Exams</h2>
        <p className="text-on-surface-variant text-sm">Manage and track your examination schedule and performance.</p>
      </div>

      <div className="flex border-b border-outline-variant mb-6">
        {(["active", "completed"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-8 py-3 font-semibold capitalize transition-all border-b-2 ${tab === t ? "text-secondary border-secondary" : "text-on-surface-variant border-transparent hover:text-secondary"}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === "active" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {active.map((e) => (
            <div key={e.id} className="bg-surface-container-lowest rounded-xl border border-outline-variant p-6 flex flex-col">
              <div className="flex justify-between items-start mb-4">
                <span className="bg-secondary-container text-on-secondary-container px-3 py-1 rounded-full text-xs uppercase tracking-wider">
                  {e.starts_at && new Date(e.starts_at).getTime() > Date.now() ? "Scheduled" : "Open"}
                </span>
                <Icon name="timer" className="text-secondary" />
              </div>
              <h3 className="font-headline text-lg text-primary mb-1">{e.title}</h3>
              <p className="text-on-surface-variant text-sm mb-4">{e.subject}</p>
              <div className="space-y-2 mb-6 text-sm text-on-surface-variant">
                <div className="flex items-center gap-2"><Icon name="schedule" className="text-[18px]" /> {e.duration_min} minutes</div>
                <div className="flex items-center gap-2"><Icon name="grade" className="text-[18px]" /> {e.total_points} points</div>
                {e.starts_at && <div className="flex items-center gap-2"><Icon name="event" className="text-[18px]" /> Opens {new Date(e.starts_at).toLocaleString()}</div>}
                {e.due_at && <div className="flex items-center gap-2"><Icon name="event_busy" className="text-[18px]" /> Due {new Date(e.due_at).toLocaleString()}</div>}
              </div>
              {e.starts_at && new Date(e.starts_at).getTime() > Date.now() ? (
                <button disabled className="mt-auto w-full bg-surface-container-high text-on-surface-variant py-3 rounded-lg font-semibold">
                  Opens later
                </button>
              ) : (
                <button onClick={() => nav(`/exams/${e.id}/take`)}
                  className="mt-auto w-full bg-secondary text-on-secondary py-3 rounded-lg font-semibold flex items-center justify-center gap-2">
                  Take Exam <Icon name="arrow_forward" className="text-[20px]" />
                </button>
              )}
            </div>
          ))}
          {active.length === 0 && <p className="text-on-surface-variant">No active exams.</p>}
        </div>
      )}

      {tab === "completed" && (
        <div className="space-y-4">
          {completed.map((a) => (
            <div key={a.id} className="bg-surface-container-lowest rounded-xl border border-outline-variant p-6 flex flex-col md:flex-row md:items-center justify-between gap-6">
              <div className="flex items-center gap-6">
                <div className="w-14 h-14 rounded-full bg-secondary-container flex items-center justify-center text-secondary">
                  <Icon name="check_circle" className="text-3xl" />
                </div>
                <div>
                  <h3 className="font-headline text-lg text-primary">{a.title}</h3>
                  <p className="text-on-surface-variant text-sm">{a.subject} • {a.status.replace("_", " ")}</p>
                </div>
              </div>
              <div className="flex items-center gap-8">
                <div className="text-center">
                  <p className="text-xs text-on-surface-variant uppercase">Score</p>
                  <p className="font-headline text-xl font-bold text-secondary">
                    {a.score != null && a.total_points ? `${Math.round((a.score / a.total_points) * 100)}%` : "—"}
                  </p>
                </div>
                <button onClick={() => nav(`/attempts/${a.id}/results`)}
                  className="bg-surface-container-high text-primary px-6 py-3 rounded-lg font-semibold hover:bg-surface-variant">
                  View Results
                </button>
              </div>
            </div>
          ))}
          {completed.length === 0 && <p className="text-on-surface-variant">No completed exams yet.</p>}
        </div>
      )}
    </Layout>
  );
}

function ExamCard({ e }: { e: Exam }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.del(`/exams/${e.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exams"] }),
  });
  const publish = useMutation({
    mutationFn: () => api.post(`/exams/${e.id}/publish`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exams"] }),
  });

  return (
    <div className="bg-surface-container-lowest rounded-xl border border-outline-variant p-6 flex flex-col">
      <div className="flex justify-between items-start mb-4">
        <span className={`px-3 py-1 rounded-full text-xs uppercase tracking-wider ${e.status === "published" ? "bg-secondary-container text-on-secondary-container" : "bg-surface-container-high text-on-surface-variant"}`}>{e.status}</span>
        <div className="flex items-center gap-2">
          <Icon name="quiz" className="text-secondary" />
          <button
            onClick={() => {
              if (confirm(`Delete exam "${e.title}"? This also removes its questions and any student attempts. This cannot be undone.`)) {
                del.mutate();
              }
            }}
            disabled={del.isPending}
            className="p-1 text-on-surface-variant hover:text-error transition-colors disabled:opacity-50"
            title="Delete exam"
          >
            <Icon name="delete" className="text-[20px]" />
          </button>
        </div>
      </div>
      <h3 className="font-headline text-lg text-primary mb-1">{e.title}</h3>
      <p className="text-on-surface-variant text-sm mb-4">{e.subject}</p>
      <div className="space-y-2 text-sm text-on-surface-variant mb-4">
        <div className="flex items-center gap-2"><Icon name="schedule" className="text-[18px]" /> {e.duration_min} min</div>
        <div className="flex items-center gap-2"><Icon name="grade" className="text-[18px]" /> {e.total_points} points</div>
        {e.starts_at && <div className="flex items-center gap-2"><Icon name="event" className="text-[18px]" /> Opens {new Date(e.starts_at).toLocaleString()}</div>}
        {e.due_at && <div className="flex items-center gap-2"><Icon name="event_busy" className="text-[18px]" /> Due {new Date(e.due_at).toLocaleString()}</div>}
      </div>
      {e.status === "published" ? (
        <button disabled
          className="mt-auto w-full bg-secondary-container text-on-secondary-container py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 cursor-default">
          <Icon name="check_circle" className="text-[20px]" /> Published
        </button>
      ) : (
        <button onClick={() => publish.mutate()} disabled={publish.isPending}
          className="mt-auto w-full bg-primary text-on-primary py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
          <Icon name="publish" className="text-[20px]" /> {publish.isPending ? "Publishing…" : "Publish"}
        </button>
      )}
      {(del.isError || publish.isError) && (
        <p className="text-error text-xs mt-3">{((del.error || publish.error) as Error).message}</p>
      )}
    </div>
  );
}
