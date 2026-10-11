import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useWaveSession } from "@/hooks/useWaveSession";
import { joinRoom, leaveRoom } from "@/lib/wave-api";
import { STATUS_LABEL } from "@/lib/webrtc-config";
import { RoomStage } from "@/components/RoomStage";

export const Route = createFileRoute("/_authenticated/room/$code")({
  head: () => ({
    meta: [
      { title: "Audio room — WAVE" },
      { name: "description", content: "Your private two-person WAVE audio room." },
      { property: "og:title", content: "Audio room — WAVE" },
      { property: "og:description", content: "Your private two-person WAVE audio room." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: RoomPage,
});

function RoomPage() {
  const { code } = useParams({ from: "/_authenticated/room/$code" });
  const navigate = useNavigate();
  const { user, firstName, nickname, avatarPath, status, loading, refresh } = useWaveSession();
  const [roomId, setRoomId] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void joinRoom(code)
      .then((room) => {
        if (active) setRoomId(room.id);
      })
      .catch((err: unknown) => {
        if (active) setJoinError(err instanceof Error ? err.message : "Could not join this room.");
      });
    return () => {
      active = false;
    };
  }, [code]);

  const handleLeave = async () => {
    if (roomId) {
      try {
        await leaveRoom(roomId);
      } catch {
        toast.error("Could not update the room, leaving anyway.");
      }
    }
    await navigate({ to: "/dashboard", replace: true });
  };

  if (joinError) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center px-6 text-center">
        <h1 className="font-display text-2xl font-bold">{joinError}</h1>
        <button
          onClick={() => navigate({ to: "/dashboard", replace: true })}
          className="mt-8 h-14 w-full rounded-2xl bg-primary text-base font-semibold text-primary-foreground"
        >
          Back to WAVE
        </button>
      </main>
    );
  }

  if (loading || !user || !roomId) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <p className="text-sm text-muted-foreground">{STATUS_LABEL.idle}</p>
      </main>
    );
  }

  return (
    <RoomStage
      roomId={roomId}
      code={code}
      selfId={user.id}
      firstName={firstName || "Friend"}
      nickname={nickname}
      avatarPath={avatarPath}
      status={status}
      onProfileChange={refresh}
      onLeave={handleLeave}
    />
  );
}
