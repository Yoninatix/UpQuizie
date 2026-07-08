import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Icon } from "../components/Layout";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email, password);
      nav("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-surface">
      <main className="w-full max-w-[460px]">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Icon name="school" className="text-primary text-4xl" />
            <h1 className="font-headline text-2xl text-primary font-bold">UpQuiz</h1>
          </div>
          <p className="text-xs text-on-surface-variant uppercase tracking-widest">
            Academic Intelligence Portal
          </p>
        </div>

        <div className="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm p-8">
          <h2 className="font-headline text-2xl text-on-surface mb-1">Welcome back</h2>
          <p className="text-on-surface-variant mb-8">Sign in to access your portal.</p>

          {error && (
            <div className="mb-4 p-3 rounded-lg bg-error-container text-on-error-container text-sm">
              {error}
            </div>
          )}

          <form onSubmit={submit} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-on-surface mb-2">Email</label>
              <div className="relative">
                <Icon name="alternate_email" className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white border border-outline-variant rounded-lg focus:border-secondary outline-none"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold text-on-surface mb-2">Password</label>
              <div className="relative">
                <Icon name="lock" className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-white border border-outline-variant rounded-lg focus:border-secondary outline-none"
                  required
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-primary text-on-primary py-3.5 rounded-lg font-semibold hover:bg-primary-container transition-all flex items-center justify-center gap-2 disabled:opacity-60"
            >
              {busy ? "Signing in…" : "Sign In"}
              <Icon name="arrow_forward" className="text-[20px]" />
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-on-surface-variant">
            Don't have an account?{" "}
            <Link to="/register" className="text-primary font-semibold hover:underline">
              Sign Up
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
