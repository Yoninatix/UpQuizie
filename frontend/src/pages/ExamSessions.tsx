import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import Layout, { Icon } from "../components/Layout";
import { api, Exam } from "../api";

export default function ExamSessions() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { data: exams = [] } = useQuery({ queryKey: ["exams"], queryFn: () => api.get<Exam[]>("/exams") });
  const liveExams = exams.filter((e) => e.exam_mode === "live" && (e.status === "published" || e.status === "closed"));
  const activation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.post(`/exams/${id}/activation`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exams"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/exams/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exams"] }),
  });

  return (
    <Layout title="Exam Sessions">
      <p className="text-on-surface-variant mb-6">Live quiz lobbies, attendance, starts, and results.</p>

      {liveExams.length === 0 ? (
        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-12 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-surface-container-high flex items-center justify-center text-on-surface-variant mb-4">
            <Icon name="live_tv" className="text-3xl" />
          </div>
          <h3 className="font-headline text-lg text-primary mb-1">No active sessions</h3>
          <p className="text-on-surface-variant text-sm max-w-sm mx-auto">
            Create a live quiz from a subject to open a monitored session here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {liveExams.map((e) => (
            <div key={e.id} className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 flex flex-col">
              <div className="flex items-center gap-2 mb-3">
                <span className={`w-2.5 h-2.5 rounded-full ${e.status === "published" ? "bg-secondary animate-pulse" : "bg-surface-container-highest"}`} />
                <span className={`font-bold text-xs uppercase tracking-widest ${e.status === "published" ? "text-secondary" : "text-on-surface-variant"}`}>
                  {e.status === "published" ? `Active · ${e.live_state}` : "Deactivated"}
                </span>
              </div>
              <h3 className="font-headline text-lg text-primary mb-1">{e.title}</h3>
              <p className="text-sm text-on-surface-variant mb-4">{e.subject}</p>
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="bg-surface-container-low p-3 rounded-lg">
                  <p className="text-xs text-on-surface-variant">Duration</p>
                  <p className="font-bold">{e.duration_min} min</p>
                </div>
                <div className="bg-surface-container-low p-3 rounded-lg">
                  <p className="text-xs text-on-surface-variant">Total Points</p>
                  <p className="font-bold">{e.total_points}</p>
                </div>
              </div>
              <button onClick={() => nav(`/exams/${e.id}/monitor`)}
                className="mt-auto w-full bg-primary text-on-primary py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2">
                <Icon name="monitoring" className="text-[20px]" /> Monitor Students
              </button>
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button
                  onClick={() => activation.mutate({ id: e.id, active: e.status !== "published" })}
                  disabled={activation.isPending}
                  className="border border-secondary text-secondary py-2 rounded-lg text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1">
                  <Icon name={e.status === "published" ? "pause_circle" : "play_circle"} className="text-[18px]" />
                  {e.status === "published" ? "Deactivate" : "Activate"}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete quiz \"${e.title}\"? All attempts and results for this quiz will also be deleted. This cannot be undone.`)) remove.mutate(e.id);
                  }}
                  disabled={remove.isPending}
                  className="border border-error text-error py-2 rounded-lg text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-1">
                  <Icon name="delete" className="text-[18px]" /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  );
}
