import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import Layout, { Icon } from "../components/Layout";
import { api } from "../api";

interface Attempt {
  id: string;
  exam_id: string;
  status: string;
  score: number | null;
  total_points: number | null;
}

export default function Results() {
  const { id } = useParams();
  const [attempt, setAttempt] = useState<Attempt | null>(null);

  useEffect(() => {
    if (id) api.get<Attempt>(`/attempts/${id}`).then(setAttempt).catch(() => {});
  }, [id]);

  return (
    <Layout title="Exam Results">
      <div className="max-w-2xl mx-auto">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 rounded-full bg-secondary-container flex items-center justify-center text-secondary mb-3">
            <Icon name="check_circle" className="text-[40px]" />
          </div>
          <h2 className="font-headline text-2xl text-primary">Assessment Submitted</h2>
          <p className="text-on-surface-variant">
            {attempt?.status === "needs_review"
              ? "Some answers require manual grading by your teacher."
              : "Your responses have been processed."}
          </p>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-8 text-center">
          <p className="text-sm uppercase tracking-widest text-secondary mb-2">Auto-graded Score</p>
          <div className="flex items-baseline justify-center gap-1">
            <span className="text-6xl font-bold text-primary">{attempt?.score ?? "—"}</span>
            <span className="text-2xl text-on-surface-variant">/ {attempt?.total_points ?? "—"} pts</span>
          </div>
          <div className="mt-4 inline-block px-4 py-1.5 rounded-full bg-secondary-container text-on-secondary-container text-sm font-semibold capitalize">
            {attempt?.status?.replace("_", " ") || "completed"}
          </div>
        </div>

        <div className="mt-8 flex justify-center">
          <Link to="/" className="px-8 py-3 bg-primary text-on-primary rounded-lg font-semibold flex items-center gap-2">
            <Icon name="home" /> Back to Dashboard
          </Link>
        </div>
      </div>
    </Layout>
  );
}
