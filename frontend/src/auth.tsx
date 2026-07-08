import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, User } from "./api";
import { useAuthStore } from "./store";

interface RegisterData {
  email: string;
  password: string;
  full_name: string;
  role: string;
  identifier?: string;
}

// Hook backed by the Zustand store. Bootstraps the session from the
// HTTP-only cookie via GET /me on first mount.
export function useAuth() {
  const { user, ready, setUser, setReady } = useAuthStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (ready) return;
    api
      .get<User>("/me")
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [ready, setUser, setReady]);

  async function login(email: string, password: string) {
    const res = await api.post<{ user: User }>("/auth/login", { email, password });
    queryClient.clear();
    setUser(res.user);
    setReady(true);
    return res.user;
  }

  async function register(data: RegisterData) {
    const res = await api.post<{ user: User }>("/auth/register", data);
    queryClient.clear();
    setUser(res.user);
    setReady(true);
    return res.user;
  }

  async function logout() {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    queryClient.clear();
    setUser(null);
  }

  return { user, loading: !ready, login, register, logout };
}
