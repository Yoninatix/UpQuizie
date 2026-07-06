import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Exam, Question, Subject } from "../api";
import { useAuth } from "../auth";

export default function SubjectDetail() {
  const { id = "" } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [previewId, setPreviewId] = useState("");

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
        <span className="px-5 py-3 border-b-2 border-secondary text-secondary font-semibold flex items-center gap-2">
          <Icon name="quiz" className="text-[20px]" /> {canManage ? "Subject Quizzes" : "Published Quizzes"}
        </span>
        <Link to={`/subjects/${id}/materials`}
          className="px-5 py-3 text-on-surface-variant font-semibold flex items-center gap-2 hover:text-secondary">
          <Icon name="folder_open" className="text-[20px]" /> Materials
        </Link>
        {canManage && (
          <Link to="/educator" className="ml-auto px-4 py-2 text-sm text-secondary font-semibold flex items-center gap-1 hover:underline">
            <Icon name="auto_awesome" className="text-[18px]" /> Generate & review
          </Link>
        )}
      </div>

      {isLoading ? (
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
                        {exam.status === "published" ? "Active" : "Deactivated"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-4 text-sm text-on-surface-variant">
                      <span className="flex items-center gap-1"><Icon name="schedule" className="text-[17px]" /> {exam.duration_min} minutes</span>
                      <span className="flex items-center gap-1"><Icon name="grade" className="text-[17px]" /> {exam.total_points} points</span>
                    </div>
                  </div>
                  {user?.role === "student" ? (
                    <Link to={`/exams/${exam.id}/take`} className="bg-secondary text-on-secondary px-5 py-2.5 rounded-lg font-semibold flex items-center justify-center gap-2">
                      Take quiz <Icon name="arrow_forward" className="text-[19px]" />
                    </Link>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setPreviewId(open ? "" : exam.id)}
                        className="border border-outline-variant px-4 py-2.5 rounded-lg font-semibold text-secondary flex items-center justify-center gap-2 hover:bg-surface-container-low">
                        <Icon name={open ? "visibility_off" : "visibility"} className="text-[19px]" /> {open ? "Close" : "Preview"}
                      </button>
                      <button onClick={() => activation.mutate({ examId: exam.id, active: exam.status !== "published" })}
                        disabled={activation.isPending}
                        className="border border-secondary px-4 py-2.5 rounded-lg font-semibold text-secondary flex items-center justify-center gap-2 disabled:opacity-50">
                        <Icon name={exam.status === "published" ? "pause_circle" : "play_circle"} className="text-[19px]" />
                        {exam.status === "published" ? "Deactivate" : "Activate"}
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
                    <h3 className="font-semibold text-primary mb-4">Quiz preview</h3>
                    {previewLoading ? <p className="text-sm text-on-surface-variant">Loading questions...</p> : (
                      <div className="space-y-3">
                        {questions.map((question, index) => (
                          <div key={question.id} className="bg-white border border-outline-variant rounded-lg p-4">
                            <div className="flex justify-between gap-4 mb-2">
                              <span className="text-xs font-bold uppercase text-secondary">Question {index + 1} · {question.type.replace("_", " ")}</span>
                              <span className="text-xs text-on-surface-variant">{question.points} pts</span>
                            </div>
                            <p className="text-sm text-on-surface">{question.prompt}</p>
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
