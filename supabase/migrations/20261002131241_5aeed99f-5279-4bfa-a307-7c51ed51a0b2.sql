ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status text CHECK (status IS NULL OR char_length(status) <= 80);

ALTER TABLE public.room_messages DROP CONSTRAINT IF EXISTS room_messages_message_check;
ALTER TABLE public.room_messages
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text',
  ADD COLUMN IF NOT EXISTS media_path text,
  ADD COLUMN IF NOT EXISTS media_mime text,
  ADD COLUMN IF NOT EXISTS delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_at timestamptz;
ALTER TABLE public.room_messages ADD CONSTRAINT room_messages_kind_check CHECK (kind IN ('text','image','video','audio'));
ALTER TABLE public.room_messages ADD CONSTRAINT room_messages_content_check CHECK (
  char_length(message) <= 500 AND (
    (kind = 'text' AND char_length(btrim(message)) >= 1 AND media_path IS NULL)
    OR (kind <> 'text' AND media_path IS NOT NULL AND split_part(media_path, '/', 1) = room_id::text AND split_part(media_path, '/', 2) = user_id::text)
  ));

-- Recipient marks partner's messages delivered / read (no direct UPDATE rights on the table).
CREATE OR REPLACE FUNCTION public.mark_room_messages(p_room_id uuid, p_read boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL OR NOT private.is_active_member(p_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  UPDATE public.room_messages SET delivered_at = COALESCE(delivered_at, now()),
    read_at = CASE WHEN p_read THEN COALESCE(read_at, now()) ELSE read_at END
  WHERE room_id = p_room_id AND user_id <> uid AND (delivered_at IS NULL OR (p_read AND read_at IS NULL));
END; $$;
REVOKE ALL ON FUNCTION public.mark_room_messages(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_room_messages(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_room_state(p_room_id uuid)
 RETURNS json LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE uid UUID := auth.uid(); result JSON;
BEGIN
  IF uid IS NULL OR NOT private.is_active_member(p_room_id, uid) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER';
  END IF;
  SELECT json_build_object(
    'id', r.id, 'code', r.code, 'status', r.status,
    'participants', COALESCE((
      SELECT json_agg(json_build_object('user_id', rp.user_id,
        'first_name', COALESCE(NULLIF(trim(p.nickname),''), p.first_name),
        'avatar_url', p.avatar_url, 'status', p.status, 'joined_at', rp.joined_at))
      FROM public.room_participants rp
      LEFT JOIN public.profiles p ON p.id = rp.user_id
      WHERE rp.room_id = r.id AND rp.left_at IS NULL
    ), '[]'::json)
  ) INTO result FROM public.rooms r WHERE r.id = p_room_id;
  RETURN result;
END;
$function$;

-- Two users currently share an active room
CREATE OR REPLACE FUNCTION private.shares_room(a uuid, b uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.room_participants x JOIN public.room_participants y ON x.room_id = y.room_id
    WHERE x.user_id = a AND y.user_id = b AND x.left_at IS NULL AND y.left_at IS NULL);
$$;
GRANT EXECUTE ON FUNCTION private.shares_room(uuid, uuid) TO authenticated;

-- Avatars: no longer world-readable; only owner and current conversation partner.
DROP POLICY IF EXISTS "avatar public read" ON storage.objects;
CREATE POLICY "avatar owner or partner read" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'avatars' AND ((storage.foldername(name))[1] = auth.uid()::text
    OR private.shares_room(auth.uid(), ((storage.foldername(name))[1])::uuid)));

-- Chat media: path = room_id/user_id/file
CREATE POLICY "chat media members read" ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'chat-media' AND private.is_active_member(((storage.foldername(name))[1])::uuid, auth.uid()));
CREATE POLICY "chat media members upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'chat-media' AND (storage.foldername(name))[2] = auth.uid()::text
  AND private.is_active_member(((storage.foldername(name))[1])::uuid, auth.uid()));