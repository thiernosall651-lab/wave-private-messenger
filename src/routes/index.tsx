import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useWaveSession } from "@/hooks/useWaveSession";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "WAVE — Talk live with one friend" },
      {
        name: "description",
        content:
          "WAVE is a private two-person audio room. Create a room, share the code, and talk in real time.",
      },
      { property: "og:title", content: "WAVE — Talk live with one friend" },
      {
        property: "og:description",
        content: "Private, real-time voice for exactly two people. No recordings, no clutter.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  const { user, loading } = useWaveSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) void navigate({ to: "/dashboard", replace: true });
  }, [loading, user, navigate]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="relative mb-10 flex h-28 w-28 items-center justify-center">
        <span className="wave-ring absolute inset-0 rounded-full bg-primary/30" />
        <span className="absolute inset-4 rounded-full bg-primary/10" />
        <span className="relative text-4xl">🎙️</span>
      </div>

      <h1 className="font-display text-5xl font-bold tracking-[0.2em] text-foreground">WAVE</h1>
      <p className="mt-4 text-balance text-base text-muted-foreground">
        A private audio room for exactly two people. Share a code, talk in real time.
      </p>

      <Link
        to="/auth"
        className="wave-glow mt-10 inline-flex h-14 w-full items-center justify-center rounded-2xl bg-primary text-base font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
      >
        Get started
      </Link>
      <p className="mt-4 text-sm text-muted-foreground">Live audio only. Nothing is recorded.</p>
    </main>
  );
}
