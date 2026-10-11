import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useWaveSession } from "@/hooks/useWaveSession";
import { createRoom, joinRoom } from "@/lib/wave-api";
import { supabase } from "@/integrations/supabase/client";
import { ProfileCard } from "@/components/ProfileCard";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Your rooms — WAVE" },
      { name: "description", content: "Create a private WAVE room or join a friend with their code." },
      { property: "og:title", content: "Your rooms — WAVE" },
      { property: "og:description", content: "Create a private WAVE room or join a friend with a code." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, firstName, nickname, avatarPath, status, refresh } = useWaveSession();
  const [joining, setJoining] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const [code, setCode] = useState("");

  const handleCreate = async () => {
    setCreating(true);
    try {
      const room = await createRoom();
      await navigate({ to: "/room/$code", params: { code: room.code } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a room");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setJoining(true);
    try {
      const room = await joinRoom(code.trim());
      await navigate({ to: "/room/$code", params: { code: room.code } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not join the room");
    } finally {
      setJoining(false);
    }
  };

  const signOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    await navigate({ to: "/auth", replace: true });
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 py-10">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-bold tracking-[0.2em]">WAVE</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Hi {firstName || "there"} — connect with a friend
          </p>
        </div>
        <button onClick={signOut} className="text-xs uppercase tracking-wider text-muted-foreground">
          Log out
        </button>
      </header>
      {user && (
        <ProfileCard userId={user.id} displayName={firstName} nickname={nickname} avatarPath={avatarPath} status={status} onChange={refresh} />
      )}

      <div className="flex flex-1 flex-col justify-center gap-4 py-12">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="wave-glow h-16 rounded-2xl bg-primary text-lg font-semibold text-primary-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {creating ? "Creating..." : "Create a Room"}
        </button>

        {!showJoin ? (
          <button
            onClick={() => setShowJoin(true)}
            className="h-16 rounded-2xl border border-border bg-secondary text-lg font-medium text-secondary-foreground transition-transform active:scale-[0.98]"
          >
            Join a Room
          </button>
        ) : (
          <form onSubmit={handleJoin} className="wave-panel flex flex-col gap-3 p-5">
            <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Room code
            </label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="WAVE-7K29"
              autoCapitalize="characters"
              className="h-14 rounded-xl border border-input bg-background px-4 text-center font-display text-xl tracking-[0.25em] text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-ring/40"
            />
            <button
              type="submit"
              disabled={joining || code.trim().length < 4}
              className="h-14 rounded-xl bg-primary text-base font-semibold text-primary-foreground disabled:opacity-50"
            >
              {joining ? "Joining..." : "Join"}
            </button>
          </form>
        )}
      </div>

      <p className="text-center text-xs text-muted-foreground">
        Rooms hold two people. Audio is live only and never recorded.
      </p>
    </main>
  );
}
