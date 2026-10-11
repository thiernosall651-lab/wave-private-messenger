
REVOKE ALL ON FUNCTION public.create_room() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_room(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.leave_room(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_room_state(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_room_capacity() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_room() TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_room(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_state(UUID) TO authenticated;

-- move the membership helper out of the exposed API schema
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

CREATE OR REPLACE FUNCTION private.is_active_member(_room_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_participants
    WHERE room_id = _room_id AND user_id = _user_id AND left_at IS NULL
  );
$$;
GRANT EXECUTE ON FUNCTION private.is_active_member(UUID, UUID) TO authenticated, service_role;

DROP POLICY "members can read room" ON public.rooms;
DROP POLICY "members can read participants" ON public.room_participants;
CREATE POLICY "members can read room" ON public.rooms FOR SELECT TO authenticated
  USING (private.is_active_member(id, auth.uid()));
CREATE POLICY "members can read participants" ON public.room_participants FOR SELECT TO authenticated
  USING (private.is_active_member(room_id, auth.uid()));

CREATE OR REPLACE FUNCTION public.get_room_state(p_room_id UUID)
RETURNS JSON LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); result JSON;
BEGIN
  IF uid IS NULL OR NOT private.is_active_member(p_room_id, uid) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER';
  END IF;
  SELECT json_build_object(
    'id', r.id, 'code', r.code, 'status', r.status,
    'participants', COALESCE((
      SELECT json_agg(json_build_object('user_id', rp.user_id, 'first_name', p.first_name, 'joined_at', rp.joined_at))
      FROM public.room_participants rp
      LEFT JOIN public.profiles p ON p.id = rp.user_id
      WHERE rp.room_id = r.id AND rp.left_at IS NULL
    ), '[]'::json)
  ) INTO result FROM public.rooms r WHERE r.id = p_room_id;
  RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION public.get_room_state(UUID) TO authenticated;
REVOKE ALL ON FUNCTION public.get_room_state(UUID) FROM PUBLIC, anon;

DROP FUNCTION IF EXISTS public.is_active_member(UUID, UUID);
