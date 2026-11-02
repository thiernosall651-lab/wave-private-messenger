-- WAVE: "Delete for everyone".
-- Soft delete: the row stays (receipts, replies and resyncs keep working) but its content is erased server-side.

ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- Same rules as before, plus: a deleted message has an empty body and no media.
ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_content_check;
ALTER TABLE public.room_messages ADD CONSTRAINT room_messages_content_check CHECK (
  char_length(message) <= 500 AND (
    (deleted_at IS NOT NULL AND media_path IS NULL AND media_mime IS NULL)
    OR
    (view_once = true AND media_path IS NULL AND media_mime IS NULL AND char_length(btrim(message)) >= 1)
    OR
    (view_once = false AND (
      (kind = 'text' AND char_length(btrim(message)) >= 1 AND media_path IS NULL)
      OR (kind <> 'text' AND media_path IS NOT NULL
        AND split_part(media_path, '/', 1) = room_id::text
        AND split_part(media_path, '/', 2) = user_id::text)
    ))
  )
);

-- Defense in depth: a deleted message can never be restored, re-filled, reacted to or opened.
CREATE OR REPLACE FUNCTION public.freeze_deleted_room_message()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND (
    NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.message IS DISTINCT FROM OLD.message
    OR NEW.media_path IS DISTINCT FROM OLD.media_path
    OR NEW.reactions IS DISTINCT FROM OLD.reactions
    OR NEW.viewed_at IS DISTINCT FROM OLD.viewed_at
  ) THEN
    RAISE EXCEPTION 'MESSAGE_DELETED';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.freeze_deleted_room_message() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS room_messages_freeze_deleted ON public.room_messages;
CREATE TRIGGER room_messages_freeze_deleted
BEFORE UPDATE ON public.room_messages
FOR EACH ROW EXECUTE FUNCTION public.freeze_deleted_room_message();

-- Only the author can delete, and only inside a room they are an active member of.
-- Returns the storage paths so the client can remove the files right after the row is cleared.
CREATE OR REPLACE FUNCTION public.delete_room_message_for_everyone(p_message_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); v_room_id uuid; v_author uuid; v_deleted_at timestamptz; v_media_path text; v_once_path text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT room_id, user_id, deleted_at, media_path INTO v_room_id, v_author, v_deleted_at, v_media_path
    FROM public.room_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
  IF NOT private.is_active_member(v_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF v_author <> uid THEN RAISE EXCEPTION 'NOT_AUTHOR'; END IF;
  IF v_deleted_at IS NOT NULL THEN RETURN jsonb_build_object('already_deleted', true); END IF;

  DELETE FROM public.room_message_view_once_payload WHERE message_id = p_message_id
    RETURNING media_path INTO v_once_path;

  UPDATE public.room_messages
     SET deleted_at = now(), deleted_by = uid, message = '', media_path = NULL, media_mime = NULL, reactions = '{}'::jsonb
   WHERE id = p_message_id;

  RETURN jsonb_build_object('already_deleted', false, 'media_path', v_media_path, 'view_once_media_path', v_once_path);
END; $$;
REVOKE ALL ON FUNCTION public.delete_room_message_for_everyone(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_room_message_for_everyone(uuid) TO authenticated;

-- Let authors remove their own files from chat-media (chat-view-once already allows it).
DROP POLICY IF EXISTS "chat media owner delete" ON storage.objects;
CREATE POLICY "chat media owner delete" ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'chat-media'
  AND (storage.foldername(name))[2] = auth.uid()::text
  AND private.is_active_member(((storage.foldername(name))[1])::uuid, auth.uid())
);
