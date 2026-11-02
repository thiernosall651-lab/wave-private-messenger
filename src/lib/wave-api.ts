import { supabase } from "@/integrations/supabase/client";

export type RoomSummary = { id: string; code: string; status: string };

export type RoomState = RoomSummary & {
  participants: { user_id: string; first_name: string; joined_at: string }[];
};

export type RoomListItem = {
  room_id: string;
  code: string;
  status: string;
  other_name: string | null;
  other_avatar: string | null;
  last_message_at: string | null;
  last_message_kind: string | null;
  last_message_preview: string | null;
  last_message_mine: boolean | null;
  last_message_deleted: boolean | null;
  last_message_view_once: boolean | null;
  unread_count: number;
  joined_at: string;
};

/** Mes salles : dernier message, heure et nombre de messages non lus. */
export async function listMyRooms(): Promise<RoomListItem[]> {
  const { data, error } = await supabase.rpc("list_my_rooms" as never);
  if (error) throw new Error(friendly(error.message));
  return (data ?? []) as unknown as RoomListItem[];
}

export async function createRoom(): Promise<RoomSummary> {
  const { data, error } = await supabase.rpc("create_room");
  if (error) throw new Error(friendly(error.message));
  return data as unknown as RoomSummary;
}

export async function joinRoom(code: string): Promise<RoomSummary> {
  const { data, error } = await supabase.rpc("join_room", { p_code: code });
  if (error) throw new Error(friendly(error.message));
  return data as unknown as RoomSummary;
}

export async function leaveRoom(roomId: string): Promise<void> {
  const { error } = await supabase.rpc("leave_room", { p_room_id: roomId });
  if (error) throw new Error(friendly(error.message));
}

export async function getRoomState(roomId: string): Promise<RoomState> {
  const { data, error } = await supabase.rpc("get_room_state", { p_room_id: roomId });
  if (error) throw new Error(friendly(error.message));
  return data as unknown as RoomState;
}

export async function getRoomByCode(code: string): Promise<RoomSummary | null> {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, code, status")
    .eq("code", code.toUpperCase())
    .maybeSingle();
  if (error) return null;
  return data;
}

function friendly(message: string): string {
  if (message.includes("ROOM_FULL")) return "This room is full.";
  if (message.includes("ROOM_NOT_FOUND")) return "No room found with that code.";
  if (message.includes("NOT_A_MEMBER")) return "You are not in this room.";
  if (message.includes("NOT_AUTHENTICATED")) return "Please sign in again.";
  return message;
}
