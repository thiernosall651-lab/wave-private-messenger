-- WAVE: delete authored messages for everyone with a durable tombstone.
ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS deleted_for_everyone boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE OR REPLACE FUNCTION public.delete_room_message_for_everyone(p_message_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, private AS $$
DECLARE uid uuid := auth.uid(); target public.room_messages; removed_path text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO target FROM public.room_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
  IF target.user_id <> uid THEN RAISE EXCEPTION 'NOT_MESSAGE_OWNER'; END IF;
  IF NOT private.is_active_member(target.room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF target.deleted_for_everyone THEN RETURN jsonb_build_object('deleted', true, 'media_path', NULL, 'view_once', false); END IF;
  removed_path := target.media_path;
  IF target.view_once THEN
    SELECT media_path INTO removed_path FROM public.room_message_view_once_payload WHERE message_id = p_message_id;
    DELETE FROM public.room_message_view_once_payload WHERE message_id = p_message_id;
  END IF;
  UPDATE public.room_messages SET message = 'This message was deleted', kind = 'text', media_path = NULL, media_mime = NULL,
    view_once = false, viewed_at = NULL, viewed_by = NULL, reactions = '{}'::jsonb,
    deleted_for_everyone = true, deleted_at = now() WHERE id = p_message_id;
  RETURN jsonb_build_object('deleted', true, 'media_path', removed_path, 'view_once', target.view_once);
END; $$;
REVOKE ALL ON FUNCTION public.delete_room_message_for_everyone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_room_message_for_everyone(uuid) TO authenticated;
