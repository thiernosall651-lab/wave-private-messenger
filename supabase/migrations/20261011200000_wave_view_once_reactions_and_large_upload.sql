-- WAVE: secure view-once payloads, private one-time media, message reactions, and larger uploads.
ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS view_once boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS viewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_content_check;
ALTER TABLE public.room_messages ADD CONSTRAINT room_messages_content_check CHECK (
  char_length(message) <= 500 AND (
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

CREATE TABLE IF NOT EXISTS public.room_message_view_once_payload (
  message_id uuid PRIMARY KEY REFERENCES public.room_messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('text','image','video','audio')),
  content text NOT NULL DEFAULT '',
  media_path text,
  media_mime text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(content) <= 500),
  CHECK ((kind = 'text' AND media_path IS NULL) OR (kind <> 'text' AND media_path IS NOT NULL))
);
ALTER TABLE public.room_message_view_once_payload ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_message_view_once_payload FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.room_message_view_once_payload TO service_role;

-- A dedicated private bucket prevents normal chat-media listing from exposing one-time media.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chat-view-once', 'chat-view-once', false, 209715200)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 209715200;
UPDATE storage.buckets SET file_size_limit = 209715200 WHERE id = 'chat-media';

CREATE OR REPLACE FUNCTION private.can_read_view_once_media(p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, private AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_message_view_once_payload p
    JOIN public.room_messages m ON m.id = p.message_id
    WHERE p.media_path = p_name AND m.view_once = true
      AND (m.user_id = auth.uid() OR (m.viewed_by = auth.uid() AND m.viewed_at > now() - interval '10 minutes'))
  );
$$;
REVOKE ALL ON FUNCTION private.can_read_view_once_media(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_read_view_once_media(text) TO authenticated;

DROP POLICY IF EXISTS "view once media members upload" ON storage.objects;
CREATE POLICY "view once media members upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'chat-view-once'
  AND (storage.foldername(name))[2] = auth.uid()::text
  AND private.is_active_member(((storage.foldername(name))[1])::uuid, auth.uid())
);
DROP POLICY IF EXISTS "view once media owner or opened recipient read" ON storage.objects;
CREATE POLICY "view once media owner or opened recipient read" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'chat-view-once' AND private.can_read_view_once_media(name)
);
DROP POLICY IF EXISTS "view once media owner delete" ON storage.objects;
CREATE POLICY "view once media owner delete" ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'chat-view-once'
  AND (storage.foldername(name))[2] = auth.uid()::text
  AND private.is_active_member(((storage.foldername(name))[1])::uuid, auth.uid())
);

CREATE OR REPLACE FUNCTION public.send_view_once_message(
  p_room_id uuid, p_kind text, p_content text, p_media_path text DEFAULT NULL,
  p_media_mime text DEFAULT NULL, p_reply_to_message_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); new_id uuid; placeholder text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT private.is_active_member(p_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF p_kind NOT IN ('text','image','video','audio') THEN RAISE EXCEPTION 'INVALID_KIND'; END IF;
  IF p_content IS NULL OR char_length(p_content) > 500 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
  IF p_kind = 'text' THEN
    IF char_length(btrim(p_content)) = 0 OR p_media_path IS NOT NULL THEN RAISE EXCEPTION 'INVALID_TEXT_MESSAGE'; END IF;
  ELSE
    IF p_media_path IS NULL OR split_part(p_media_path, '/', 1) <> p_room_id::text OR split_part(p_media_path, '/', 2) <> uid::text THEN
      RAISE EXCEPTION 'INVALID_MEDIA_PATH';
    END IF;
  END IF;
  IF p_reply_to_message_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.room_messages WHERE id = p_reply_to_message_id AND room_id = p_room_id) THEN
    RAISE EXCEPTION 'REPLY_INVALID';
  END IF;
  placeholder := CASE p_kind WHEN 'text' THEN 'View-once message' WHEN 'image' THEN 'Photo · View once' WHEN 'video' THEN 'Video · View once' ELSE 'Voice message · View once' END;
  INSERT INTO public.room_messages (room_id, user_id, message, kind, media_path, media_mime, reply_to_message_id, view_once)
  VALUES (p_room_id, uid, placeholder, p_kind, NULL, NULL, p_reply_to_message_id, true) RETURNING id INTO new_id;
  INSERT INTO public.room_message_view_once_payload (message_id, kind, content, media_path, media_mime)
  VALUES (new_id, p_kind, p_content, p_media_path, p_media_mime);
  RETURN new_id;
END; $$;
REVOKE ALL ON FUNCTION public.send_view_once_message(uuid, text, text, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_view_once_message(uuid, text, text, text, text, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.open_view_once_message(p_message_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); v_room_id uuid; v_sender_id uuid; v_kind text; v_view_once boolean; v_viewed_at timestamptz;
  v_content text; v_media_path text; v_media_mime text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT room_id, user_id, kind, view_once, viewed_at INTO v_room_id, v_sender_id, v_kind, v_view_once, v_viewed_at
    FROM public.room_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
  IF NOT private.is_active_member(v_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF NOT v_view_once THEN RAISE EXCEPTION 'NOT_VIEW_ONCE'; END IF;
  IF v_sender_id = uid THEN RAISE EXCEPTION 'SENDER_CANNOT_OPEN'; END IF;
  IF v_viewed_at IS NOT NULL THEN RETURN jsonb_build_object('already_opened', true); END IF;
  IF v_kind = 'text' THEN
    DELETE FROM public.room_message_view_once_payload WHERE message_id = p_message_id
      RETURNING content, media_path, media_mime INTO v_content, v_media_path, v_media_mime;
  ELSE
    SELECT content, media_path, media_mime INTO v_content, v_media_path, v_media_mime
      FROM public.room_message_view_once_payload WHERE message_id = p_message_id;
  END IF;
  IF v_content IS NULL THEN RAISE EXCEPTION 'ALREADY_OPENED'; END IF;
  UPDATE public.room_messages SET viewed_at = now(), viewed_by = uid WHERE id = p_message_id;
  RETURN jsonb_build_object('already_opened', false, 'kind', v_kind, 'content', v_content, 'media_path', v_media_path, 'media_mime', v_media_mime);
END; $$;
REVOKE ALL ON FUNCTION public.open_view_once_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_view_once_message(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.toggle_room_message_reaction(p_message_id uuid, p_emoji text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); v_room_id uuid; v_reactions jsonb; v_users jsonb; v_new_users jsonb;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF p_emoji NOT IN ('❤️','😂','😮','😢','👍','🙏','🔥','💯') THEN RAISE EXCEPTION 'INVALID_REACTION'; END IF;
  SELECT room_id, COALESCE(reactions, '{}'::jsonb) INTO v_room_id, v_reactions FROM public.room_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
  IF NOT private.is_active_member(v_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  v_users := COALESCE(v_reactions -> p_emoji, '[]'::jsonb);
  IF v_users @> jsonb_build_array(uid::text) THEN
    SELECT COALESCE(jsonb_agg(value), '[]'::jsonb) INTO v_new_users FROM jsonb_array_elements_text(v_users) AS e(value) WHERE e.value <> uid::text;
  ELSE
    v_new_users := v_users || jsonb_build_array(uid::text);
  END IF;
  IF jsonb_array_length(v_new_users) = 0 THEN v_reactions := v_reactions - p_emoji;
  ELSE v_reactions := jsonb_set(v_reactions, ARRAY[p_emoji], v_new_users, true); END IF;
  UPDATE public.room_messages SET reactions = v_reactions WHERE id = p_message_id;
  RETURN v_reactions;
END; $$;
REVOKE ALL ON FUNCTION public.toggle_room_message_reaction(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_room_message_reaction(uuid, text) TO authenticated;
