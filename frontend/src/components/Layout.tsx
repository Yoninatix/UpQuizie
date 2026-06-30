import { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <span className={`material-symbols-outlined ${className}`}>{name}</span>;
}

interface NavItem { label: string; icon: string; to: string }

const navByRole: Record<string, NavItem[]> = {
  student: [
    { label: "Dashboard", icon: "dashboard", to: "/student" },
    { label: "Subjects", icon: "library_books", to: "/subjects" },
    { label: "Exams", icon: "assignment", to: "/exams" },
  ],
  educator: [
    { label: "Subjects", icon: "book", to: "/subjects" },
    { label: "Learning Materials", icon: "folder_open", to: "/materials" },
    { label: "Generate & Review", icon: "auto_awesome", to: "/educator" },
    { label: "Exams", icon: "quiz", to: "/exams" },
    { label: "Exam Sessions", icon: "live_tv", to: "/sessions" },
    { label: "Analytics", icon: "analytics", to: "/analytics" },
  ],
  admin: [
    { label: "User Management", icon: "group", to: "/admin/users" },
  ],
};

export default function Layout({ children, title }: { children: ReactNode; title: string }) {
  const { user, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const items = navByRole[user?.role || "student"] || [];

  return (
    <div className="min-h-screen bg-surface">
      {/* Sidebar */}
      <aside className="fixed left-0 top-0 h-screen w-64 bg-surface-container-low border-r border-outline-variant flex flex-col z-40">
        <div className="px-6 py-6 flex items-center gap-3">
          <div className="w-10 h-10 bg-primary-container rounded-lg flex items-center justify-center text-white">
            <Icon name="school" />
          </div>
          <div>
            <h1 className="font-headline text-xl font-bold text-primary leading-tight">UpQuiz</h1>
            <p className="text-[10px] uppercase tracking-widest text-on-surface-variant font-semibold">
              Academic Management
            </p>
          </div>
        </div>
        <nav className="flex-1 px-4 space-y-1 overflow-y-auto">
          {items.map((it) => {
            const active = loc.pathname === it.to;
            return (
              <Link
                key={it.to}
                to={it.to}
                className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
                  active
                    ? "bg-secondary-container text-on-secondary-container"
                    : "text-on-surface-variant hover:bg-surface-container-high"
                }`}
              >
                <Icon name={it.icon} />
                {it.label}
              </Link>
            );
          })}
        </nav>
        <div className="p-4 border-t border-outline-variant">
          <button
            onClick={() => { logout(); nav("/login"); }}
            className="flex items-center gap-3 px-4 py-3 w-full rounded-lg text-on-surface-variant hover:bg-surface-container-high text-sm font-semibold"
          >
            <Icon name="logout" />
            Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="ml-64 flex flex-col min-h-screen">
        <header className="h-16 bg-surface-container-lowest border-b border-outline-variant flex items-center justify-between px-8 sticky top-0 z-30">
          <h2 className="font-headline text-xl font-bold text-primary">{title}</h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-on-surface-variant hidden sm:block">{user?.full_name}</span>
            <div className="w-9 h-9 rounded-full bg-primary-container text-on-primary flex items-center justify-center font-bold text-sm">
              {user?.full_name?.[0] || "U"}
            </div>
          </div>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
