ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id uuid NULL REFERENCES public.room_messages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS room_messages_reply_to_idx ON public.room_messages(reply_to_message_id);

CREATE OR REPLACE FUNCTION public.check_reply_same_room()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.room_messages o
    WHERE o.id = NEW.reply_to_message_id AND o.room_id = NEW.room_id
  ) THEN
    RAISE EXCEPTION 'REPLY_INVALID';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.check_reply_same_room() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_messages_reply_check ON public.room_messages;
CREATE TRIGGER room_messages_reply_check
BEFORE INSERT OR UPDATE OF reply_to_message_id ON public.room_messages
FOR EACH ROW EXECUTE FUNCTION public.check_reply_same_room();