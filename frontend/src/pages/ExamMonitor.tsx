import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import Layout, { Icon } from "../components/Layout";
import { api, ExamMonitor as Monitor, MonitorStudent } from "../api";

const ONLINE_WINDOW_SEC = 30; // last heartbeat within this window == "online"

function secsBetween(fromISO: string | null, toMs: number): number | null {
  if (!fromISO) return null;
  return Math.max(0, Math.round((toMs - new Date(fromISO).getTime()) / 1000));
}

function fmtClock(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const statusStyle: Record<string, string> = {
  not_started: "bg-surface-container-high text-on-surface-variant",
  waiting: "bg-blue-100 text-blue-800",
  in_progress: "bg-secondary-container text-on-secondary-container",
  completed: "bg-green-100 text-green-800",
  needs_review: "bg-orange-100 text-orange-800",
};
const statusLabel: Record<string, string> = {
  not_started: "Not started",
  waiting: "In lobby",
  in_progress: "In progress",
  completed: "Submitted",
  needs_review: "Needs review",
};

export default function ExamMonitor() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["exam-monitor", id],
    queryFn: () => api.get<Monitor>(`/exams/${id}/monitor`),
    enabled: !!id,
    refetchInterval: 4000,
  });
  const start = useMutation({
    mutationFn: () => api.post(`/exams/${id}/start`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exam-monitor", id] }),
  });
  const activation = useMutation({
    mutationFn: (active: boolean) => api.post(`/exams/${id}/activation`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exam-monitor", id] }),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/exams/${id}`),
    onSuccess: () => nav("/sessions"),
  });

  if (isLoading) {
    return <Layout title="Live Monitor"><p className="text-on-surface-variant">Loading session…</p></Layout>;
  }
  if (isError || !data) {
    return (
      <Layout title="Live Monitor">
        <p className="text-error mb-4">{(error as Error)?.message || "Could not load this session."}</p>
        <button onClick={() => nav("/sessions")} className="text-secondary font-semibold">← Back to Exam Sessions</button>
      </Layout>
    );
  }

  const nowMs = new Date(data.now).getTime();
  const { exam, summary, students } = data;
  const finished = students.filter((s) => s.submitted_at)
    .sort((a, b) => new Date(a.submitted_at!).getTime() - new Date(b.submitted_at!).getTime());
  const scored = finished.filter((s) => s.score != null).sort((a, b) => (b.score! / (b.total_points || 1)) - (a.score! / (a.total_points || 1)));

  if (exam.exam_mode === "live" && exam.live_state === "waiting") {
    const joinedPct = summary.enrolled ? Math.round((summary.waiting / summary.enrolled) * 100) : 0;
    const copyCode = async () => {
      if (!exam.access_code) return;
      await navigator.clipboard.writeText(exam.access_code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    };

    return (
      <Layout title="Exam Lobby">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-7">
            <div>
              <button onClick={() => nav("/sessions")} className="flex items-center gap-1 text-secondary text-sm font-semibold mb-2 hover:underline">
                <Icon name="arrow_back" className="text-[18px]" /> Exam Sessions
              </button>
              <h1 className="font-headline text-3xl font-bold text-primary">Exam Lobby</h1>
              <p className="text-on-surface-variant mt-1">Students can join using the access code.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => activation.mutate(exam.status !== "published")} disabled={activation.isPending}
                className="border border-secondary text-secondary px-4 py-2.5 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50">
                <Icon name={exam.status === "published" ? "pause_circle" : "play_circle"} />
                {exam.status === "published" ? "Deactivate" : "Activate"}
              </button>
              <button onClick={() => {
                if (confirm(`Delete quiz \"${exam.title}\"? All attempts and results will also be deleted. This cannot be undone.`)) remove.mutate();
              }} disabled={remove.isPending}
                className="border border-error text-error px-4 py-2.5 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50">
                <Icon name="delete" /> Delete
              </button>
            </div>
          </div>

          <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-6 md:p-8 mb-5">
            <div className="grid md:grid-cols-[1.4fr_0.65fr_0.9fr] md:divide-x divide-outline-variant gap-6 md:gap-0 items-center">
              <div className="flex items-center gap-5 md:pr-8">
                <div className="w-20 h-20 rounded-xl bg-secondary-container text-secondary flex items-center justify-center shrink-0">
                  <Icon name="assignment" className="text-[38px]" />
                </div>
                <div><h2 className="font-headline text-xl font-bold text-primary">{exam.title}</h2>
                  <p className="text-on-surface-variant mt-2">{exam.question_count} questions <span className="mx-2">•</span> {exam.total_points} points <span className="mx-2">•</span> {exam.duration_min} minutes</p>
                </div>
              </div>
              <div className="md:px-8 text-center">
                <p className="text-xs uppercase tracking-wider text-on-surface-variant font-semibold">Access code</p>
                <p className="font-mono text-3xl font-bold tracking-[0.18em] text-secondary my-2">{exam.access_code}</p>
                <button onClick={copyCode} className="mx-auto border border-secondary text-secondary px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2 hover:bg-secondary-container/30">
                  <Icon name={copied ? "check" : "content_copy"} className="text-[18px]" /> {copied ? "Copied" : "Copy code"}
                </button>
              </div>
              <div className="md:pl-8 text-sm text-on-surface-variant leading-6">
                <p className="font-semibold text-on-surface mb-1">Share this code with participating students.</p>
                <p>Only students enrolled in this subject can use the code and enter this lobby.</p>
              </div>
            </div>
          </section>

          {exam.status !== "published" && (
            <div className="bg-orange-50 border border-orange-200 text-orange-800 rounded-xl px-5 py-3 mb-5 flex items-center gap-2">
              <Icon name="warning" /> This quiz is deactivated. Activate it before students can join.
            </div>
          )}

          <div className="grid lg:grid-cols-[1.55fr_0.95fr] gap-5">
            <section className="bg-surface-container-lowest border border-outline-variant rounded-2xl overflow-hidden">
              <div className="px-6 py-5 border-b border-outline-variant flex items-center justify-between gap-3">
                <div><h3 className="font-headline text-lg font-bold text-primary">Students who can join this quiz</h3><p className="text-sm text-on-surface-variant mt-1">Only enrolled students can join using the access code.</p></div>
                <span className="bg-green-100 text-green-700 rounded-full px-3 py-1 text-sm font-bold whitespace-nowrap">{summary.enrolled} students</span>
              </div>
              <div className="px-6 py-2">
                <div className="grid grid-cols-[44px_1fr_auto] py-3 text-xs font-bold uppercase tracking-wider text-on-surface-variant border-b border-outline-variant">
                  <span>#</span><span>Student name</span><span>Status</span>
                </div>
                {students.map((student, index) => {
                  const joined = student.status === "waiting";
                  return <div key={student.student_id} className="grid grid-cols-[44px_1fr_auto] py-3 border-b last:border-0 border-outline-variant items-center text-sm">
                    <span className="text-on-surface-variant">{index + 1}.</span>
                    <div><p className="font-semibold text-on-surface">{student.name}</p>{student.identifier && <p className="text-xs text-on-surface-variant">{student.identifier}</p>}</div>
                    <span className={`flex items-center gap-1.5 font-semibold ${joined ? "text-green-600" : "text-on-surface-variant"}`}>
                      <Icon name={joined ? "check_circle" : "schedule"} className="text-[18px]" /> {joined ? "Joined" : "Not joined"}
                    </span>
                  </div>;
                })}
                {students.length === 0 && <p className="py-10 text-center text-on-surface-variant">No students are enrolled in this subject yet.</p>}
              </div>
              <div className="m-6 mt-3 bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-3 text-sm text-blue-800">
                <Icon name="info" className="shrink-0" /><p><span className="font-semibold">Only these {summary.enrolled} students can join this quiz.</span><br />Other students cannot access it with the code.</p>
              </div>
            </section>

            <aside className="bg-surface-container-lowest border border-outline-variant rounded-2xl p-6 h-fit">
              <h3 className="font-headline text-lg font-bold text-primary mb-6">Lobby summary</h3>
              <div className="space-y-6">
                <LobbyStat icon="group" tone="green" label="Joined" detail={`${summary.waiting} of ${summary.enrolled} students`} value={`${joinedPct}%`} />
                <LobbyStat icon="schedule" tone="gray" label="Not joined" detail={`${summary.not_started} of ${summary.enrolled} students`} value={`${100 - joinedPct}%`} />
              </div>
              <div className="border-t border-outline-variant mt-7 pt-6">
                <h4 className="font-bold text-primary">Start the quiz anytime</h4>
                <p className="text-sm text-on-surface-variant mt-2 leading-6">Only students who have joined will start together. Late students with the code can still enter while the quiz is active.</p>
                <button onClick={() => { if (confirm(`Start the quiz for ${summary.waiting} student(s) currently in the lobby?`)) start.mutate(); }}
                  disabled={start.isPending || summary.waiting === 0 || exam.status !== "published"}
                  className="w-full mt-5 bg-secondary text-on-secondary py-3 rounded-lg font-bold flex items-center justify-center gap-2 disabled:opacity-50">
                  <Icon name="play_arrow" /> {start.isPending ? "Starting…" : `Start quiz (${summary.waiting} ready)`}
                </button>
              </div>
            </aside>
          </div>

          <section className="mt-5 bg-blue-50/70 border border-blue-200 rounded-2xl p-6">
            <h3 className="font-bold text-secondary mb-5">How it works</h3>
            <div className="grid md:grid-cols-3 gap-6">
              <HowStep icon="group" title="Share the code" text="Give the access code to the students taking this quiz." />
              <HowStep icon="meeting_room" title="Students join" text="Enrolled students enter the code and appear in this lobby." />
              <HowStep icon="play_circle" title="Start the quiz" text="Start when you are ready; joined students begin together." />
            </div>
          </section>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Live Monitor">
      <button onClick={() => nav("/sessions")}
        className="flex items-center gap-1 text-secondary font-semibold text-sm mb-4 hover:underline">
        <Icon name="arrow_back" className="text-[18px]" /> Exam Sessions
      </button>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-secondary rounded-full animate-pulse" />
            <h2 className="font-headline text-2xl text-primary">{exam.title}</h2>
          </div>
          <p className="text-on-surface-variant text-sm">
            {exam.question_count} questions • {exam.duration_min} min • {exam.total_points} points • live (auto-refreshes)
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {exam.exam_mode === "live" && exam.live_state === "waiting" && exam.status === "published" && (
            <button onClick={() => { if (confirm(`Start the quiz for ${summary.waiting} student(s) currently in the lobby?`)) start.mutate(); }}
              disabled={start.isPending || summary.waiting === 0}
              className="bg-secondary text-on-secondary px-6 py-3 rounded-lg font-bold flex items-center gap-2 disabled:opacity-50">
              <Icon name="play_arrow" /> {start.isPending ? "Starting…" : `Start exam (${summary.waiting} ready)`}
            </button>
          )}
          <button onClick={() => activation.mutate(exam.status !== "published")} disabled={activation.isPending}
            className="border border-secondary text-secondary px-4 py-3 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50">
            <Icon name={exam.status === "published" ? "pause_circle" : "play_circle"} />
            {exam.status === "published" ? "Deactivate" : "Activate"}
          </button>
          <button onClick={() => {
            if (confirm(`Delete quiz \"${exam.title}\"? All attempts and results will also be deleted. This cannot be undone.`)) remove.mutate();
          }} disabled={remove.isPending}
            className="border border-error text-error px-4 py-3 rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50">
            <Icon name="delete" /> Delete
          </button>
        </div>
      </div>

      {exam.exam_mode === "live" && (
        <div className="bg-primary text-on-primary rounded-xl p-5 mb-6 flex flex-wrap items-center justify-between gap-4">
          <div><p className="text-xs uppercase tracking-widest opacity-70">Student access code</p><p className="font-mono text-3xl font-bold tracking-[0.25em]">{exam.access_code}</p></div>
          <div className="text-right"><p className="text-xs uppercase tracking-widest opacity-70">Session</p><p className="font-bold capitalize">{exam.live_state}</p></div>
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <Tile label="Enrolled" value={summary.enrolled} icon="group" />
        <Tile label="Not started" value={summary.not_started} icon="schedule" tone="muted" />
        <Tile label="In lobby" value={summary.waiting} icon="meeting_room" tone="secondary" />
        <Tile label="In progress" value={summary.in_progress} icon="edit_note" tone="secondary" />
        <Tile label="Submitted" value={summary.submitted} icon="task_alt" tone="success" />
      </div>

      {finished.length > 0 && (
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          <RankingCard label="Finished first" icon="speed" student={finished[0]} detail={`Submitted ${new Date(finished[0].submitted_at!).toLocaleTimeString()}`} />
          <RankingCard label="Highest score" icon="emoji_events" student={scored[0]} detail={scored[0] ? `${scored[0].score}/${scored[0].total_points} points` : "Awaiting scores"} />
          <RankingCard label="Lowest score" icon="trending_down" student={scored[scored.length - 1]} detail={scored.length ? `${scored[scored.length - 1].score}/${scored[scored.length - 1].total_points} points` : "Awaiting scores"} />
        </div>
      )}

      {/* Roster */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <div className="hidden md:grid grid-cols-[1.6fr_1fr_1.4fr_1fr_1fr] gap-4 px-6 py-3 bg-surface-container-low text-[11px] font-bold uppercase tracking-wider text-outline">
          <span>Student</span><span>Status</span><span>Progress</span><span>Time</span><span>Score</span>
        </div>
        <div className="divide-y divide-outline-variant">
          {students.map((s) => (
            <StudentRow key={s.student_id} s={s} nowMs={nowMs} durationMin={exam.duration_min} liveStartedAt={exam.live_started_at} />
          ))}
          {students.length === 0 && (
            <p className="px-6 py-8 text-on-surface-variant text-sm">
              No students are enrolled in this subject yet. Enroll students to monitor their sessions.
            </p>
          )}
        </div>
      </div>
    </Layout>
  );
}

function StudentRow({ s, nowMs, durationMin, liveStartedAt }: { s: MonitorStudent; nowMs: number; durationMin: number; liveStartedAt: string | null }) {
  const sinceSeen = secsBetween(s.last_seen_at, nowMs);
  const online = s.status === "in_progress" && sinceSeen != null && sinceSeen <= ONLINE_WINDOW_SEC;
  const away = s.status === "in_progress" && s.focused === false;

  const elapsed = secsBetween(liveStartedAt || s.started_at, nowMs);
  const remaining = elapsed != null ? durationMin * 60 - elapsed : null;
  const pct = s.question_count > 0 ? Math.round((s.answered_count / s.question_count) * 100) : 0;
  const scorePct =
    s.score != null && s.total_points ? Math.round((s.score / s.total_points) * 100) : null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1.6fr_1fr_1.4fr_1fr_1fr] gap-2 md:gap-4 px-6 py-4 items-center">
      {/* Student + presence */}
      <div className="flex items-center gap-3">
        <span
          title={online ? "Online" : "Offline"}
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${online ? "bg-green-500 animate-pulse" : "bg-surface-container-highest"}`}
        />
        <div className="min-w-0">
          <p className="font-semibold text-on-surface truncate">{s.name}</p>
          {s.identifier && <p className="text-xs text-on-surface-variant truncate">{s.identifier}</p>}
        </div>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        <span className={`px-3 py-1 rounded-full text-xs font-semibold ${statusStyle[s.status]}`}>
          {statusLabel[s.status]}
        </span>
        {away && (
          <span title="Exam tab is not focused" className="flex items-center gap-1 text-xs font-semibold text-error">
            <Icon name="warning" className="text-[15px]" /> Away
          </span>
        )}
      </div>

      {/* Progress */}
      <div>
        {s.status === "in_progress" || s.status === "completed" || s.status === "needs_review" ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-secondary rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs text-on-surface-variant whitespace-nowrap">
              {s.answered_count}/{s.question_count}
            </span>
          </div>
        ) : (
          <span className="text-xs text-on-surface-variant">—</span>
        )}
      </div>

      {/* Time */}
      <div className="text-sm">
        {s.status === "in_progress" && remaining != null ? (
          <span className={`font-mono ${remaining < 300 ? "text-error font-bold" : "text-on-surface-variant"}`}>
            {fmtClock(remaining)} left
          </span>
        ) : s.status === "not_started" || s.status === "waiting" ? (
          <span className="text-on-surface-variant">—</span>
        ) : (
          <span className="text-on-surface-variant">Done</span>
        )}
      </div>

      {/* Score */}
      <div className="text-sm">
        {scorePct != null ? (
          <span className="font-bold text-primary">
            {scorePct}% <span className="text-on-surface-variant font-normal">({s.score}/{s.total_points})</span>
          </span>
        ) : (
          <span className="text-on-surface-variant">—</span>
        )}
      </div>
    </div>
  );
}

function RankingCard({ label, icon, student, detail }: { label: string; icon: string; student?: MonitorStudent; detail: string }) {
  return <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 flex items-center gap-4">
    <div className="w-11 h-11 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center"><Icon name={icon} /></div>
    <div><p className="text-xs uppercase tracking-wider text-on-surface-variant">{label}</p><p className="font-bold text-primary">{student?.name || "—"}</p><p className="text-xs text-on-surface-variant">{detail}</p></div>
  </div>;
}

function LobbyStat({ icon, tone, label, detail, value }: { icon: string; tone: "green" | "gray"; label: string; detail: string; value: string }) {
  const colors = tone === "green" ? "bg-green-100 text-green-600" : "bg-surface-container-high text-on-surface-variant";
  return <div className="flex items-center gap-4">
    <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${colors}`}><Icon name={icon} /></div>
    <div className="flex-1"><p className="font-bold text-primary">{label}</p><p className="text-sm text-on-surface-variant">{detail}</p></div>
    <span className={`font-bold ${tone === "green" ? "text-green-600" : "text-on-surface-variant"}`}>{value}</span>
  </div>;
}

function HowStep({ icon, title, text }: { icon: string; title: string; text: string }) {
  return <div className="flex items-start gap-4">
    <div className="w-11 h-11 rounded-full bg-white text-secondary flex items-center justify-center shrink-0"><Icon name={icon} /></div>
    <div><p className="font-bold text-primary">{title}</p><p className="text-sm text-on-surface-variant mt-1 leading-6">{text}</p></div>
  </div>;
}

function Tile({ label, value, icon, tone = "primary" }: { label: string; value: number; icon: string; tone?: string }) {
  const toneCls: Record<string, string> = {
    primary: "text-primary",
    secondary: "text-secondary",
    success: "text-green-600",
    muted: "text-on-surface-variant",
  };
  return (
    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs uppercase tracking-wider text-on-surface-variant">{label}</p>
        <Icon name={icon} className={`text-[20px] ${toneCls[tone]}`} />
      </div>
      <p className={`font-headline text-3xl font-bold mt-2 ${toneCls[tone]}`}>{value}</p>
    </div>
  );
}
