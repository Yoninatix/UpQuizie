import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Exam, Subject } from "../api";
import { useAuth } from "../auth";

const subjectColors = ["bg-primary", "bg-secondary", "bg-tertiary", "bg-primary-container"];

export default function StudentDashboard() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [greeting, setGreeting] = useState("Good day");
  useEffect(() => {
    const hour = new Date().getHours();
    setGreeting(hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
  }, []);

  const { data: exams = [] } = useQuery({ queryKey: ["exams"], queryFn: () => api.get<Exam[]>("/exams") });
  const { data: subjects = [] } = useQuery({ queryKey: ["subjects"], queryFn: () => api.get<Subject[]>("/subjects") });
  const available = exams.filter((exam) => exam.status === "published");

  return <Layout title="Dashboard">
    <header className="mb-8">
      <h1 className="font-headline text-3xl text-primary mb-2">{greeting}, {user?.full_name?.split(" ")[0]}.</h1>
      <p className="text-on-surface-variant flex items-center gap-2"><Icon name="calendar_today" className="text-secondary" />You have <span className="font-bold text-primary">{available.length}</span> exam{available.length === 1 ? "" : "s"} available.</p>
    </header>

    <section>
      <div className="mb-4"><h2 className="font-headline text-2xl text-primary mb-1">My Subjects</h2><p className="text-sm text-on-surface-variant">Open a subject to view its published quizzes and learning materials.</p></div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {subjects.map((subject, index) => <button key={subject.id} onClick={() => nav(`/subjects/${subject.id}`)} className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden text-left transition-all hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-secondary">
          <div className={`h-20 ${subjectColors[index % subjectColors.length]} relative`}>
            <span className="absolute top-3 left-3 bg-primary-container/80 backdrop-blur text-on-primary-container px-2 py-1 rounded text-[10px] font-bold uppercase">{subject.code}</span>
            <div className="absolute -bottom-5 left-6 w-12 h-12 bg-white shadow rounded-xl flex items-center justify-center text-primary"><Icon name="book" className="text-3xl" /></div>
          </div>
          <div className="pt-8 px-6 pb-5">
            <h3 className="font-headline text-lg text-primary mb-1">{subject.name}</h3>
            <p className="text-sm text-on-surface-variant mb-4">{subject.department || "No department"}</p>
            <div className="flex items-center justify-between border-t border-outline-variant pt-3 text-sm"><span className="text-on-surface-variant">{subject.active_exams} active exam{subject.active_exams === 1 ? "" : "s"}</span><span className="text-secondary font-semibold flex items-center gap-1">Open Subject <Icon name="arrow_forward" className="text-[18px]" /></span></div>
          </div>
        </button>)}
        {subjects.length === 0 && <div className="md:col-span-2 xl:col-span-3 bg-surface-container-lowest border border-dashed border-outline-variant rounded-xl p-8 text-center text-on-surface-variant"><Icon name="library_books" className="text-4xl mb-2" /><p>You are not enrolled in any subjects yet.</p></div>}
      </div>
    </section>
  </Layout>;
}
