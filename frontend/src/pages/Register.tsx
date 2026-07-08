import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { Icon } from "../components/Layout";

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [role, setRole] = useState<"student" | "educator">("student");
  const [form, setForm] = useState({ full_name: "", email: "", identifier: "", password: "" });
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function upd(k: string, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (form.password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await register({ ...form, role });
      nav("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-[480px] bg-white border border-outline-variant rounded-xl shadow-sm p-8">
        <header className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-primary-container rounded-lg mb-4">
            <Icon name="school" className="text-on-primary-container text-[28px]" />
          </div>
          <h1 className="font-headline text-2xl text-primary mb-1">Create your account</h1>
          <p className="text-sm text-on-surface-variant">Join the next generation of academic excellence</p>
        </header>

        <div className="flex p-1 bg-surface-container-high rounded-lg mb-8">
          {(["student", "educator"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              className={`flex-1 py-2 px-4 rounded-md text-sm font-semibold capitalize transition-all ${
                role === r ? "bg-white text-primary shadow-sm" : "text-on-surface-variant"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-error-container text-on-error-container text-sm">{error}</div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <Field label="Full Name" value={form.full_name} onChange={(v) => upd("full_name", v)} />
          <Field label="Institutional Email" type="email" value={form.email} onChange={(v) => upd("email", v)} />
          <Field
            label={role === "student" ? "Student ID Number" : "Employee Number"}
            value={form.identifier}
            onChange={(v) => upd("identifier", v)}
          />
          <Field label="Password" type="password" value={form.password} onChange={(v) => upd("password", v)} />
          <Field label="Confirm Password" type="password" value={confirmPassword} onChange={setConfirmPassword} />
          {confirmPassword && form.password !== confirmPassword && (
            <p className="text-sm text-error -mt-2">Passwords do not match.</p>
          )}
          <button
            type="submit"
            disabled={busy || (confirmPassword !== "" && form.password !== confirmPassword)}
            className="w-full h-12 bg-primary-container text-white rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create Account"}
            <Icon name="arrow_forward" className="text-[20px]" />
          </button>
        </form>

        <footer className="mt-8 pt-6 border-t border-outline-variant text-center">
          <p className="text-sm text-on-surface-variant">
            Already have an account?{" "}
            <Link to="/login" className="text-primary font-semibold hover:underline">
              Sign in
            </Link>
          </p>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="text-sm font-semibold text-on-surface">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required
        className="mt-1.5 w-full h-11 px-4 bg-white border border-outline-variant rounded-lg focus:border-secondary outline-none"
      />
    </div>
  );
}
