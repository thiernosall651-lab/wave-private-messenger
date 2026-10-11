CREATE TABLE public.room_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  message text NOT NULL CHECK (char_length(btrim(message)) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_messages_room_created_idx ON public.room_messages (room_id, created_at);
GRANT SELECT, INSERT ON public.room_messages TO authenticated;
GRANT ALL ON public.room_messages TO service_role;
ALTER TABLE public.room_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read messages" ON public.room_messages FOR SELECT TO authenticated
  USING (private.is_active_member(room_id, auth.uid()));
CREATE POLICY "members send messages" ON public.room_messages FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND private.is_active_member(room_id, auth.uid()));
ALTER TABLE public.room_messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.room_messages;