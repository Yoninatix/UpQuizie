import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Subject } from "../api";

interface Student {
  id: string;
  full_name: string;
  email: string;
  identifier?: string;
  enrolled_at: string;
}

export default function Enrollment() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [bulk, setBulk] = useState("");
  const [msg, setMsg] = useState("");

  const { data: subjects = [] } = useQuery({
    queryKey: ["subjects"],
    queryFn: () => api.get<Subject[]>("/subjects"),
  });
  const subject = subjects.find((s) => s.id === id);

  const { data: students = [] } = useQuery({
    queryKey: ["students", id],
    queryFn: () => api.get<Student[]>(`/subjects/${id}/students`),
    enabled: !!id,
  });

  const enroll = useMutation({
    mutationFn: (e: string) => api.post(`/subjects/${id}/enroll`, { email: e }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["students", id] });
      qc.invalidateQueries({ queryKey: ["subjects"] });
    },
  });
  const drop = useMutation({
    mutationFn: (studentId: string) => api.del(`/subjects/${id}/students/${studentId}`),
    onSuccess: () => {
      setMsg("Student dropped from this subject.");
      qc.invalidateQueries({ queryKey: ["students", id] });
      qc.invalidateQueries({ queryKey: ["subjects"] });
    },
    onError: (error: Error) => setMsg(error.message),
  });

  async function enrollOne() {
    if (!email.trim()) return;
    try {
      await enroll.mutateAsync(email.trim());
      setEmail("");
      setMsg("Student enrolled.");
    } catch (e: any) {
      setMsg(e.message);
    }
  }

  async function enrollBulk() {
    const emails = bulk.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    let ok = 0;
    for (const e of emails) {
      try { await enroll.mutateAsync(e); ok++; } catch { /* skip */ }
    }
    setBulk("");
    setMsg(`Enrolled ${ok} of ${emails.length}.`);
  }

  return (
    <Layout title="Enrollment Management">
      <button onClick={() => nav("/subjects")}
        className="flex items-center gap-1 text-secondary text-sm font-semibold mb-4 hover:underline">
        <Icon name="arrow_back" className="text-[18px]" /> Back to Subjects
      </button>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <nav className="flex items-center gap-2 text-sm text-on-surface-variant mb-1">
            <span>Subjects</span><Icon name="chevron_right" className="text-sm" /><span className="font-semibold text-primary">Enrollment</span>
          </nav>
          <h2 className="font-headline text-3xl font-bold text-primary">{subject?.name || "Subject"}</h2>
        </div>
        <div className="bg-surface-container-lowest border border-outline-variant px-6 py-3 rounded-xl flex items-center gap-4">
          <div className="w-10 h-10 bg-secondary-container text-on-secondary-container rounded-lg flex items-center justify-center">
            <Icon name="group" />
          </div>
          <div>
            <p className="text-xs text-on-surface-variant uppercase tracking-wider">Total Enrolled</p>
            <p className="text-xl font-bold text-primary">{students.length} Students</p>
          </div>
        </div>
      </div>

      {msg && <p className="text-sm text-secondary mb-4">{msg}</p>}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Left: tools */}
        <div className="xl:col-span-4 flex flex-col gap-6">
          <section className="bg-surface-container-lowest rounded-xl border border-outline-variant p-6">
            <h3 className="font-headline text-lg text-primary mb-4">Add Individual Student</h3>
            <div className="space-y-3">
              <div className="relative">
                <Icon name="person_search" className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" />
                <input value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="student@university.edu"
                  className="w-full pl-10 pr-4 py-3 bg-surface-container-low border border-transparent rounded-lg focus:bg-white focus:border-secondary outline-none text-sm" />
              </div>
              <button onClick={enrollOne} disabled={enroll.isPending}
                className="w-full bg-secondary text-on-secondary py-3 rounded-lg font-semibold flex items-center justify-center gap-2 disabled:opacity-60">
                <Icon name="person_add" /> Enroll Student
              </button>
            </div>
          </section>

          <section className="bg-surface-container-lowest rounded-xl border border-outline-variant overflow-hidden">
            <div className="p-6 border-b border-outline-variant">
              <h3 className="font-headline text-lg text-primary">Bulk Enrollment</h3>
              <p className="text-sm text-on-surface-variant">Paste student emails (one per line or comma-separated)</p>
            </div>
            <div className="p-6 space-y-3">
              <textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={5}
                placeholder="alice@university.edu&#10;bob@university.edu"
                className="w-full p-3 bg-surface-container-low border border-transparent rounded-lg focus:bg-white focus:border-secondary outline-none text-sm resize-none" />
              <button onClick={enrollBulk} disabled={enroll.isPending}
                className="w-full border-2 border-secondary text-secondary py-2 rounded-lg font-semibold text-sm hover:bg-secondary hover:text-on-secondary transition-all disabled:opacity-60">
                Process List
              </button>
            </div>
          </section>
        </div>

        {/* Right: roster */}
        <div className="xl:col-span-8">
          <section className="bg-surface-container-lowest rounded-xl border border-outline-variant h-full">
            <div className="p-6 border-b border-outline-variant">
              <h3 className="font-headline text-lg text-primary">Student Roster</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-surface-container-low border-b border-outline-variant text-xs font-bold text-on-surface-variant uppercase tracking-wider">
                    <th className="px-6 py-4">Student</th>
                    <th className="px-6 py-4">Email</th>
                    <th className="px-6 py-4">ID</th>
                    <th className="px-6 py-4">Enrolled</th>
                    <th className="px-6 py-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant">
                  {students.map((s) => (
                    <tr key={s.id} className="hover:bg-surface-container-low">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs">
                            {s.full_name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                          </div>
                          <span className="font-medium text-primary">{s.full_name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-on-surface-variant">{s.email}</td>
                      <td className="px-6 py-4 text-on-surface-variant">{s.identifier || "—"}</td>
                      <td className="px-6 py-4 text-on-surface-variant text-sm">
                        {new Date(s.enrolled_at).toLocaleDateString()}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex justify-end">
                          <button
                            onClick={() => {
                              if (confirm(`Drop ${s.full_name} from ${subject?.name || "this subject"}? Their account and other subjects will remain.`)) {
                                drop.mutate(s.id);
                              }
                            }}
                            disabled={drop.isPending}
                            className="inline-flex items-center gap-1 border border-outline-variant text-on-surface-variant px-3 py-1.5 rounded-lg text-sm font-semibold hover:text-secondary hover:border-secondary disabled:opacity-50"
                          >
                            <Icon name="person_remove" className="text-[17px]" /> Drop
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {students.length === 0 && <p className="p-6 text-on-surface-variant">No students enrolled yet.</p>}
            </div>
          </section>
        </div>
      </div>
    </Layout>
  );
}
