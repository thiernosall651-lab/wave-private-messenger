ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS nickname text, ADD COLUMN IF NOT EXISTS avatar_url text;

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
        'avatar_url', p.avatar_url, 'joined_at', rp.joined_at))
      FROM public.room_participants rp
      LEFT JOIN public.profiles p ON p.id = rp.user_id
      WHERE rp.room_id = r.id AND rp.left_at IS NULL
    ), '[]'::json)
  ) INTO result FROM public.rooms r WHERE r.id = p_room_id;
  RETURN result;
END;
$function$;

CREATE POLICY "avatar public read" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "avatar own insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatar own update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatar own delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);