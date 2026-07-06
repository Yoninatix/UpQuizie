import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./auth";
import Login from "./pages/Login";
import Register from "./pages/Register";
import StudentDashboard from "./pages/StudentDashboard";
import EducatorDashboard from "./pages/EducatorDashboard";
import Materials from "./pages/Materials";
import Subjects from "./pages/Subjects";
import ExamsList from "./pages/ExamsList";
import ExamSessions from "./pages/ExamSessions";
import ScoreReview from "./pages/ScoreReview";
import Enrollment from "./pages/Enrollment";
import TakeExam from "./pages/TakeExam";
import Results from "./pages/Results";
import Analytics from "./pages/Analytics";
import StudentPerformance from "./pages/StudentPerformance";
import StudentCalendar from "./pages/StudentCalendar";
import Settings from "./pages/Settings";
import AdminUsers from "./pages/AdminUsers";
import SubjectDetail from "./pages/SubjectDetail";
import ExamMonitor from "./pages/ExamMonitor";

function Protected({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-10 text-on-surface-variant">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Home() {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-10 text-on-surface-variant">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === "admin") return <Navigate to="/admin/users" replace />;
  if (user.role === "student") return <Navigate to="/student" replace />;
  return <Navigate to="/subjects" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/" element={<Home />} />
      <Route path="/student" element={<Protected><StudentDashboard /></Protected>} />
      <Route path="/educator" element={<Protected><EducatorDashboard /></Protected>} />
      <Route path="/materials" element={<Protected><Materials /></Protected>} />
      <Route path="/subjects/:id/materials" element={<Protected><Materials /></Protected>} />
      <Route path="/subjects/:id/enroll" element={<Protected><Enrollment /></Protected>} />
      <Route path="/review" element={<Navigate to="/educator#review-questions" replace />} />
      <Route path="/analytics" element={<Protected><Analytics /></Protected>} />
      <Route path="/performance" element={<Protected><StudentPerformance /></Protected>} />
      <Route path="/calendar" element={<Protected><StudentCalendar /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="/sessions" element={<Protected><ExamSessions /></Protected>} />
      <Route path="/score-review" element={<Protected><ScoreReview /></Protected>} />
      <Route path="/subjects" element={<Protected><Subjects /></Protected>} />
      <Route path="/subjects/:id" element={<Protected><SubjectDetail /></Protected>} />
      <Route path="/exams" element={<Protected><ExamsList /></Protected>} />
      <Route path="/exams/:id/take" element={<Protected><TakeExam /></Protected>} />
      <Route path="/exams/:id/monitor" element={<Protected><ExamMonitor /></Protected>} />
      <Route path="/attempts/:id/results" element={<Protected><Results /></Protected>} />
      <Route path="/admin/users" element={<Protected><AdminUsers /></Protected>} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
