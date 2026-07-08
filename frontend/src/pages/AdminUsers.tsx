import { useEffect, useMemo, useState } from "react";
import Layout, { Icon } from "../components/Layout";
import { api, ApiError } from "../api";

interface AdminUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  identifier?: string | null;
  status: string;
  created_at?: string;
}

const roleBadge: Record<string, string> = {
  admin: "bg-tertiary-fixed text-on-tertiary-container",
  educator: "bg-secondary-fixed text-on-secondary-container",
  student: "bg-primary-fixed text-on-primary-container",
};

const avatarColor: Record<string, string> = {
  admin: "bg-tertiary-container text-on-tertiary-container",
  educator: "bg-secondary-container text-on-secondary-container",
  student: "bg-primary-container text-on-primary-container",
};

const statusDot: Record<string, string> = {
  active: "bg-green-500",
  pending: "bg-orange-400",
  inactive: "bg-outline",
};

const statusPill: Record<string, string> = {
  active: "bg-green-50 text-green-800 border border-green-200",
  pending: "bg-orange-50 text-orange-800 border border-orange-200",
  inactive: "bg-surface-container-high text-on-surface-variant border border-outline-variant",
};

const PER_PAGE = 10;

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

function joinedLabel(iso?: string) {
  if (!iso) return "";
  return "Joined " + new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

// Page numbers with ellipsis, e.g. 1 2 3 … 125 (always keeps current visible).
function pageItems(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, 2, 3, current - 1, current, current + 1, total]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

interface UserForm {
  full_name: string;
  email: string;
  password: string;
  identifier: string;
  role: string;
  status: string;
}

const emptyForm: UserForm = { full_name: "", email: "", password: "", identifier: "", role: "student", status: "active" };

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState("");
  const [editingJoined, setEditingJoined] = useState<string | undefined>();
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    api.get<AdminUser[]>("/admin/users").then(setUsers).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== "all" && u.role !== roleFilter) return false;
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (!q) return true;
      return (
        u.full_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.identifier ?? "").toLowerCase().includes(q)
      );
    });
  }, [users, search, roleFilter, statusFilter]);

  useEffect(() => { setPage(1); }, [search, roleFilter, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);
  const showingFrom = filtered.length === 0 ? 0 : (safePage - 1) * PER_PAGE + 1;
  const showingTo = Math.min(safePage * PER_PAGE, filtered.length);

  const openCreate = () => {
    setForm(emptyForm);
    setError("");
    setModal("create");
  };

  const openEdit = (u: AdminUser) => {
    setEditingId(u.id);
    setEditingJoined(u.created_at);
    setForm({ full_name: u.full_name, email: u.email, password: "", identifier: u.identifier ?? "", role: u.role, status: u.status });
    setError("");
    setModal("edit");
  };

  const closeModal = () => { if (!saving) setModal(null); };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      if (modal === "create") {
        const created = await api.post<AdminUser>("/admin/users", {
          full_name: form.full_name.trim(),
          email: form.email.trim(),
          password: form.password,
          identifier: form.identifier.trim(),
          role: form.role,
          status: form.status,
        });
        setUsers((list) => [created, ...list]);
      } else {
        await api.patch(`/admin/users/${editingId}`, {
          full_name: form.full_name.trim(),
          email: form.email.trim(),
          identifier: form.identifier.trim(),
          role: form.role,
          status: form.status,
        });
        setUsers((list) => list.map((u) => u.id === editingId
          ? { ...u, full_name: form.full_name.trim(), email: form.email.trim(), identifier: form.identifier.trim(), role: form.role, status: form.status }
          : u));
      }
      setModal(null);
    } catch (e) {
      setError((e as ApiError).message || "Request failed.");
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async (u: AdminUser) => {
    if (!confirm(`Delete ${u.full_name}'s account? This cannot be undone.`)) return;
    setDeletingId(u.id);
    setDeleteError("");
    try {
      await api.del(`/admin/users/${u.id}`);
      setUsers((list) => list.filter((x) => x.id !== u.id));
      if (modal === "edit" && editingId === u.id) setModal(null);
    } catch (e) {
      setDeleteError((e as ApiError).message || "Could not delete user.");
    } finally {
      setDeletingId(null);
    }
  };

  const exportCsv = () => {
    const header = "Name,Email,ID Number,Role,Status,Joined";
    const lines = filtered.map((u) =>
      [u.full_name, u.email, u.identifier ?? "", u.role, u.status, u.created_at ?? ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([header + "\n" + lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "users.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const canSubmit = form.full_name.trim() && form.email.trim() &&
    (modal === "edit" || form.password.length >= 6);

  return (
    <Layout title="Manage Users">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <p className="text-on-surface-variant text-sm">Provision and manage institutional access across roles.</p>
        <button onClick={openCreate}
          className="px-5 py-2.5 bg-primary text-on-primary rounded-lg font-semibold whitespace-nowrap flex items-center gap-2 self-start sm:self-auto">
          <Icon name="person_add" className="text-[18px]" /> Add New User
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-4 mb-6 flex flex-col md:flex-row gap-3 md:items-end">
        <label className="flex-1 space-y-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Search Users</span>
          <div className="relative">
            <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[20px]" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email or ID number…"
              className="w-full border border-outline-variant rounded-lg pl-10 pr-3 py-2 bg-white outline-none focus:border-secondary" />
          </div>
        </label>
        <label className="space-y-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Role</span>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
            className="block w-full md:w-40 border border-outline-variant rounded-lg px-3 py-2 bg-white">
            <option value="all">All Roles</option>
            <option value="student">Student</option>
            <option value="educator">Educator</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label className="space-y-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Status</span>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
            className="block w-full md:w-40 border border-outline-variant rounded-lg px-3 py-2 bg-white">
            <option value="all">All Status</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        {deleteError && <p className="text-sm text-error basis-full">{deleteError}</p>}
        <button onClick={exportCsv} title="Export to CSV"
          className="p-2.5 border border-outline-variant rounded-lg text-on-surface-variant hover:bg-surface-container-high">
          <Icon name="download" />
        </button>
      </div>

      {/* Users table */}
      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-surface-container-low border-b border-outline-variant text-sm text-on-surface-variant">
              <th className="px-6 py-4">Name</th>
              <th className="px-6 py-4">Email Address</th>
              <th className="px-6 py-4">ID No.</th>
              <th className="px-6 py-4">Role</th>
              <th className="px-6 py-4">Status</th>
              <th className="px-6 py-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant">
            {pageRows.map((u) => (
              <tr key={u.id} className="hover:bg-surface-container-low">
                <td className="px-6 py-4">
                  <div className="flex items-center gap-3">
                    <span className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${avatarColor[u.role] || "bg-surface-container-high"}`}>
                      {initials(u.full_name)}
                    </span>
                    <div className="min-w-0">
                      <p className="font-semibold text-primary truncate">{u.full_name}</p>
                      <p className="text-xs text-on-surface-variant">{joinedLabel(u.created_at)}</p>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 text-on-surface">{u.email}</td>
                <td className="px-6 py-4 text-on-surface-variant">{u.identifier || "—"}</td>
                <td className="px-6 py-4">
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${roleBadge[u.role] || ""}`}>
                    {u.role}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${statusPill[u.status] || ""}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot[u.status] || "bg-outline"}`} />
                    {u.status}
                  </span>
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => openEdit(u)} title="View / edit user"
                      className="p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-secondary rounded transition-colors">
                      <Icon name="edit" className="text-[18px]" />
                    </button>
                    <button onClick={() => deleteUser(u)} disabled={deletingId === u.id} title="Delete user"
                      className="p-2 text-on-surface-variant hover:bg-error-container hover:text-error rounded transition-colors disabled:opacity-50">
                      <Icon name="delete" className="text-[18px]" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pageRows.length === 0 && (
          <p className="p-6 text-on-surface-variant">
            {users.length === 0 ? "No users." : "No users match the current filters."}
          </p>
        )}

        {/* Pagination footer */}
        <div className="px-6 py-4 bg-surface-container-low border-t border-outline-variant flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-sm text-on-surface-variant">
            Showing {showingFrom}–{showingTo} of {filtered.length} user{filtered.length === 1 ? "" : "s"}
          </p>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1}
              className="w-9 h-9 rounded-lg border border-outline-variant flex items-center justify-center text-on-surface-variant disabled:opacity-40 hover:bg-surface-container-high">
              <Icon name="chevron_left" className="text-[20px]" />
            </button>
            {pageItems(safePage, totalPages).map((item, i) =>
              item === "…" ? (
                <span key={`e${i}`} className="w-9 h-9 flex items-center justify-center text-on-surface-variant text-sm">…</span>
              ) : (
                <button key={item} onClick={() => setPage(item)}
                  className={`w-9 h-9 rounded-lg text-sm font-semibold ${
                    item === safePage
                      ? "bg-primary text-on-primary"
                      : "border border-outline-variant text-on-surface-variant hover:bg-surface-container-high"
                  }`}>
                  {item}
                </button>
              ))}
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
              className="w-9 h-9 rounded-lg border border-outline-variant flex items-center justify-center text-on-surface-variant disabled:opacity-40 hover:bg-surface-container-high">
              <Icon name="chevron_right" className="text-[20px]" />
            </button>
          </div>
        </div>
      </div>

      {/* Create / Edit modal */}
      {modal && (
        <div className="fixed inset-0 z-50 bg-primary/35 backdrop-blur-sm flex items-center justify-center p-4" onClick={closeModal}>
          <div className="w-full max-w-lg bg-surface-container-lowest rounded-2xl shadow-2xl border border-outline-variant overflow-hidden"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 border-b border-outline-variant flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest text-secondary font-bold">
                  {modal === "create" ? "New account" : "User details"}
                </p>
                <h2 className="font-headline text-xl font-bold text-primary">
                  {modal === "create" ? "Add New User" : form.full_name || "Edit user"}
                </h2>
                {modal === "edit" && editingJoined && (
                  <p className="text-xs text-on-surface-variant mt-1">{joinedLabel(editingJoined)}</p>
                )}
              </div>
              <button onClick={closeModal}
                className="w-10 h-10 rounded-full hover:bg-surface-container-high flex items-center justify-center text-on-surface-variant">
                <Icon name="close" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Full name</span>
                <input value={form.full_name} onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
                  className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Email</span>
                <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
              </label>
              {modal === "create" && (
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Password (min. 6 characters)</span>
                  <input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
                </label>
              )}
              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-wider text-outline">ID number (student / employee)</span>
                <input value={form.identifier} onChange={(e) => setForm((f) => ({ ...f, identifier: e.target.value }))}
                  className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white outline-none focus:border-secondary" />
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Role</span>
                  <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                    className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white">
                    <option value="student">Student</option>
                    <option value="educator">Educator</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-outline">Status</span>
                  <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                    className="w-full border border-outline-variant rounded-lg px-3 py-2 bg-white">
                    <option value="active">Active</option>
                    <option value="pending">Pending</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </label>
              </div>
              {error && <p className="text-sm text-error">{error}</p>}
            </div>
            <div className="px-6 py-4 bg-surface-container-low border-t border-outline-variant flex justify-between items-center gap-3">
              {modal === "edit" ? (
                <button onClick={() => { const u = users.find((x) => x.id === editingId); if (u) deleteUser(u); }}
                  disabled={saving || deletingId === editingId}
                  className="px-4 py-2 border border-error text-error rounded-lg font-semibold disabled:opacity-50 flex items-center gap-1.5">
                  <Icon name="delete" className="text-[18px]" /> {deletingId === editingId ? "Deleting…" : "Delete account"}
                </button>
              ) : <span />}
              <div className="flex gap-3">
                <button onClick={closeModal} disabled={saving}
                  className="px-5 py-2 border border-outline-variant text-on-surface-variant rounded-lg font-semibold disabled:opacity-50">
                  Cancel
                </button>
                <button onClick={submit} disabled={saving || !canSubmit}
                  className="px-6 py-2 bg-primary text-on-primary rounded-lg font-semibold disabled:opacity-50">
                  {saving ? "Saving…" : modal === "create" ? "Create user" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}
