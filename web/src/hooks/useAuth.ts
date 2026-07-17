import { useEffect, useState } from "react";
import { api, ApiError, type AuthedUser } from "../api";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: AuthedUser };

export function useAuth(): AuthState & { refresh: () => void } {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    api
      .me()
      .then(({ user }) => {
        if (!cancelled) setState({ status: "authenticated", user });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ status: "anonymous" });
        } else {
          console.error("Failed to resolve session:", err);
          setState({ status: "anonymous" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}
