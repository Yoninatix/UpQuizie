import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Layout, { Icon } from "../components/Layout";
import { api, Subject } from "../api";
import { useAuth } from "../auth";

const headerColors = ["bg-primary", "bg-secondary", "bg-tertiary", "bg-primary-container"];

export default function Subjects() {
  const { user } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", department: "", description: "" });

  const { data: subjects = [] } = useQuery({ queryKey: ["subjects"], queryFn: () => api.get<Subject[]>("/subjects") });

  const create = useMutation({
    mutationFn: () => api.post("/subjects", form),
    onSuccess: () => { setForm({ code: "", name: "", department: "", description: "" }); setShowForm(false); qc.invalidateQueries({ queryKey: ["subjects"] }); },
  });
  const toggle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/subjects/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subjects"] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/subjects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["subjects"] }),
  });

  const canManage = user?.role === "educator" || user?.role === "admin";

  return (
    <Layout title="Subjects">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-8">
        <div>
          <h2 className="font-headline text-2xl text-primary mb-1">Subjects</h2>
          <p className="text-on-surface-variant max-w-xl text-sm">Open a subject to view its published quizzes and learning materials.</p>
        </div>
        {canManage && (
          <button onClick={() => setShowForm((s) => !s)}
            className="bg-secondary text-on-secondary px-5 py-2.5 rounded-lg font-semibold flex items-center gap-2">
            <Icon name="add_circle" /> New Subject
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}
          className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 mb-6 grid grid-cols-2 gap-4">
          {(["code", "name", "department", "description"] as const).map((k) => (
            <input key={k} placeholder={k[0].toUpperCase() + k.slice(1)} value={(form as any)[k]}
              onChange={(e) => setForm({ ...form, [k]: e.target.value })}
              className="border border-outline-variant rounded-lg px-3 py-2.5 outline-none focus:border-secondary"
              required={k === "code" || k === "name"} />
          ))}
          <button type="submit" disabled={create.isPending} className="col-span-2 bg-primary text-on-primary py-2.5 rounded-lg font-semibold disabled:opacity-60">Create</button>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {subjects.map((s, i) => {
          const archived = s.status === "archived";
          return (
            <div key={s.id}
              className={`bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden transition-all hover:shadow-lg ${archived ? "opacity-60 grayscale" : ""}`}>
              <div className={`h-24 ${headerColors[i % headerColors.length]} relative cursor-pointer`} onClick={() => nav(`/subjects/${s.id}`)}>
                <span className="absolute top-3 left-3 bg-primary-container/80 backdrop-blur text-on-primary-container px-2 py-1 rounded text-[10px] font-bold uppercase">{s.code}</span>
                <span className={`absolute top-3 right-3 px-2 py-1 rounded-full text-[10px] font-bold uppercase flex items-center gap-1 ${archived ? "bg-surface-dim/80 text-on-surface" : "bg-primary-container/80 text-on-primary-container"}`}>
                  <span className={`w-2 h-2 rounded-full ${archived ? "bg-on-surface-variant" : "bg-green-400"}`} /> {archived ? "Archived" : "Active"}
                </span>
                <div className="absolute -bottom-5 left-6 w-12 h-12 bg-white shadow rounded-xl flex items-center justify-center text-primary">
                  <Icon name="book" className="text-3xl" />
                </div>
              </div>
              <div className="pt-8 px-6 pb-6">
                <h3 className="font-headline text-lg text-primary mb-1">{s.name}</h3>
                <p className="text-sm text-on-surface-variant mb-4">{s.department || "—"}</p>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-surface-container-low p-3 rounded-lg"><p className="text-xs text-on-surface-variant">Students</p><p className="font-bold">{s.students}</p></div>
                  <div className="bg-surface-container-low p-3 rounded-lg"><p className="text-xs text-on-surface-variant">Active Exams</p><p className="font-bold">{s.active_exams}</p></div>
                </div>
                <div className="flex items-center justify-between border-t border-outline-variant pt-3 text-sm">
                  <div className="flex items-center gap-3">
                    <button onClick={() => nav(`/subjects/${s.id}`)} className="text-secondary font-semibold flex items-center gap-1 hover:underline">
                      <Icon name="open_in_new" className="text-[18px]" /> Open Subject
                    </button>
                    {canManage && (
                      <button onClick={() => nav(`/subjects/${s.id}/enroll`)} className="text-secondary font-semibold flex items-center gap-1 hover:underline">
                        <Icon name="group_add" className="text-[18px]" /> Enroll
                      </button>
                    )}
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      <button onClick={() => toggle.mutate({ id: s.id, status: archived ? "active" : "archived" })}
                        title={archived ? "Activate" : "Deactivate"} className="p-1.5 text-on-surface-variant hover:text-secondary">
                        <Icon name={archived ? "toggle_off" : "toggle_on"} className="text-[20px]" />
                      </button>
                      <button onClick={() => { if (confirm(`Delete "${s.name}"?`)) remove.mutate(s.id); }}
                        title="Delete" className="p-1.5 text-on-surface-variant hover:text-error">
                        <Icon name="delete" className="text-[20px]" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {canManage && (
          <button onClick={() => setShowForm(true)}
            className="border-2 border-dashed border-outline-variant rounded-xl flex flex-col items-center justify-center p-8 text-on-surface-variant hover:border-secondary hover:bg-surface-container-low transition-all min-h-[260px]">
            <div className="w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center mb-4">
              <Icon name="add" className="text-3xl" />
            </div>
            <h4 className="font-headline text-lg">Add New Subject</h4>
            <p className="text-sm text-center mt-2 px-6">Initialize a new curriculum module and enroll students.</p>
          </button>
        )}
      </div>
    </Layout>
  );
}
