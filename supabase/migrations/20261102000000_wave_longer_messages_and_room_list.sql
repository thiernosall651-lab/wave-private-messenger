-- WAVE : messages plus longs (4000 caractères) + liste des salles avec messages non lus.
-- À exécuter une seule fois dans Supabase > SQL Editor (nécessite la migration « supprimer pour tout le monde »).

-- 1) Longueur maximale d'un message : 500 -> 4000 caractères
ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_content_check;
ALTER TABLE public.room_messages ADD CONSTRAINT room_messages_content_check CHECK (
  char_length(message) <= 4000 AND (
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

ALTER TABLE public.room_message_view_once_payload DROP CONSTRAINT IF EXISTS room_message_view_once_payload_content_check;
ALTER TABLE public.room_message_view_once_payload ADD CONSTRAINT room_message_view_once_payload_content_check CHECK (char_length(content) <= 4000);

CREATE OR REPLACE FUNCTION public.send_view_once_message(
  p_room_id uuid, p_kind text, p_content text, p_media_path text DEFAULT NULL,
  p_media_mime text DEFAULT NULL, p_reply_to_message_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); new_id uuid; placeholder text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT private.is_active_member(p_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  IF p_kind NOT IN ('text','image','video','audio') THEN RAISE EXCEPTION 'INVALID_KIND'; END IF;
  IF p_content IS NULL OR char_length(p_content) > 4000 THEN RAISE EXCEPTION 'INVALID_CONTENT'; END IF;
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

-- 2) Liste des salles avec non lus
-- Liste des salles de l'utilisateur : dernier message, heure et nombre de messages non lus (comme WhatsApp).
CREATE OR REPLACE FUNCTION public.list_my_rooms()
RETURNS TABLE (
  room_id uuid, code text, status text,
  other_name text, other_avatar text,
  last_message_at timestamptz, last_message_kind text, last_message_preview text,
  last_message_mine boolean, last_message_deleted boolean, last_message_view_once boolean,
  unread_count integer, joined_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.code, r.status,
         COALESCE(NULLIF(trim(p.nickname), ''), NULLIF(trim(p.first_name), '')),
         p.avatar_url,
         lm.created_at, lm.kind,
         CASE WHEN lm.deleted_at IS NOT NULL OR lm.view_once THEN NULL ELSE left(lm.message, 120) END,
         (lm.user_id = auth.uid()),
         (lm.deleted_at IS NOT NULL),
         COALESCE(lm.view_once, false),
         COALESCE(un.cnt, 0)::integer,
         me.joined_at
  FROM public.room_participants me
  JOIN public.rooms r ON r.id = me.room_id
  LEFT JOIN LATERAL (
    SELECT rp.user_id FROM public.room_participants rp
    WHERE rp.room_id = r.id AND rp.left_at IS NULL AND rp.user_id <> auth.uid() LIMIT 1
  ) o ON true
  LEFT JOIN public.profiles p ON p.id = o.user_id
  LEFT JOIN LATERAL (
    SELECT m.created_at, m.kind, m.message, m.user_id, m.deleted_at, m.view_once
    FROM public.room_messages m WHERE m.room_id = r.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1
  ) lm ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS cnt FROM public.room_messages m
    WHERE m.room_id = r.id AND m.user_id <> auth.uid() AND m.read_at IS NULL AND m.deleted_at IS NULL
  ) un ON true
  WHERE me.user_id = auth.uid() AND me.left_at IS NULL
  ORDER BY COALESCE(lm.created_at, me.joined_at) DESC;
$$;
REVOKE ALL ON FUNCTION public.list_my_rooms() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_rooms() TO authenticated;
