import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { consumeRoomDestination } from "@/lib/post-login";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Sign in — WAVE" },
      { name: "description", content: "Create your WAVE account or sign in to start a private audio room." },
      { property: "og:title", content: "Sign in — WAVE" },
      { property: "og:description", content: "Create your WAVE account or sign in to start talking." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkEmail, setCheckEmail] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const navigatedRef = useRef(false);
  // After login: go to the room from the invite link if there was one, else the dashboard.
  const goNext = useCallback(() => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    const code = consumeRoomDestination();
    if (code) void navigate({ to: "/room/$code", params: { code }, replace: true });
    else void navigate({ to: "/dashboard", replace: true });
  }, [navigate]);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) goNext();
    });
    void supabase.auth.getUser().then(({ data }) => {
      if (data.user) goNext();
    });
    return () => sub.subscription.unsubscribe();
  }, [goNext]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: window.location.origin,
            data: { first_name: firstName.trim() },
          },
        });
        if (error) throw error;
        if (!data.session) {
          setCheckEmail(true);
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  if (checkEmail) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6 text-center">
        <h1 className="font-display text-3xl font-bold">Check your email</h1>
        <p className="mt-3 text-muted-foreground">
          We sent a confirmation link to <span className="text-foreground">{email}</span>. Open it to
          activate your account, then come back and sign in.
        </p>
        <button
          onClick={() => {
            setCheckEmail(false);
            setMode("signin");
          }}
          className="mt-8 h-12 rounded-2xl border border-border bg-secondary text-sm font-medium text-secondary-foreground"
        >
          Back to sign in
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-center font-display text-4xl font-bold tracking-[0.2em]">WAVE</h1>
      <p className="mt-2 text-center text-sm text-muted-foreground">
        {mode === "signin" ? "Welcome back." : "Create your account."}
      </p>

      <form onSubmit={submit} className="wave-panel mt-8 flex flex-col gap-4 p-6">
        {mode === "signup" && (
          <Field
            label="First name"
            value={firstName}
            onChange={setFirstName}
            type="text"
            autoComplete="given-name"
            required
          />
        )}
        <Field label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" required />
        <Field
          label="Password"
          value={password}
          onChange={setPassword}
          type={showPassword ? "text" : "password"}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
          required
          trailing={
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              title={showPassword ? "Hide password" : "Show password"}
              className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
            </button>
          }
        />

        <button
          type="submit"
          disabled={busy}
          className="wave-glow mt-2 h-14 rounded-2xl bg-primary text-base font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? "Please wait..." : mode === "signin" ? "Sign in" : "Sign up"}
        </button>
      </form>

      <button
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="mt-6 text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {mode === "signin" ? "No account yet? Sign up" : "Already have an account? Sign in"}
      </button>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type,
  autoComplete,
  required,
  trailing,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type: string;
  autoComplete: string;
  required?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <label className="relative flex flex-col gap-2 text-left">
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        autoComplete={autoComplete}
        required={required}
        className={`h-13 rounded-xl border border-input bg-background py-3 pl-4 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/40 ${
          trailing ? "pr-12" : "pr-4"
        }`}
      />
      {trailing}
    </label>
  );
}
