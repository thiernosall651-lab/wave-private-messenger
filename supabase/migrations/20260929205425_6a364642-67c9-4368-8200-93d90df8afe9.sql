
-- PROFILES
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());

-- ROOMS
CREATE TABLE public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.rooms TO authenticated;
GRANT ALL ON public.rooms TO service_role;
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

-- PARTICIPANTS
CREATE TABLE public.room_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ
);
GRANT SELECT ON public.room_participants TO authenticated;
GRANT ALL ON public.room_participants TO service_role;
ALTER TABLE public.room_participants ENABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX room_participants_active_unique
  ON public.room_participants (room_id, user_id) WHERE left_at IS NULL;
CREATE INDEX room_participants_room_idx ON public.room_participants (room_id);
CREATE INDEX room_participants_user_idx ON public.room_participants (user_id);
CREATE INDEX rooms_code_idx ON public.rooms (code);

-- MEMBERSHIP HELPER (security definer, avoids recursive RLS)
CREATE OR REPLACE FUNCTION public.is_active_member(_room_id UUID, _user_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.room_participants
    WHERE room_id = _room_id AND user_id = _user_id AND left_at IS NULL
  );
$$;

CREATE POLICY "members can read room" ON public.rooms FOR SELECT TO authenticated
  USING (public.is_active_member(id, auth.uid()));
CREATE POLICY "members can read participants" ON public.room_participants FOR SELECT TO authenticated
  USING (public.is_active_member(room_id, auth.uid()));

-- HARD 2-PARTICIPANT LIMIT
CREATE OR REPLACE FUNCTION public.enforce_room_capacity()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE active_count INT;
BEGIN
  IF NEW.left_at IS NULL THEN
    SELECT count(*) INTO active_count FROM public.room_participants
      WHERE room_id = NEW.room_id AND left_at IS NULL AND id <> NEW.id;
    IF active_count >= 2 THEN
      RAISE EXCEPTION 'ROOM_FULL';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER room_capacity_check
  BEFORE INSERT OR UPDATE ON public.room_participants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_room_capacity();

-- NEW USER -> PROFILE
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, first_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- CREATE ROOM
CREATE OR REPLACE FUNCTION public.create_room()
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid UUID := auth.uid();
  new_code TEXT;
  new_room public.rooms;
  attempts INT := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  LOOP
    attempts := attempts + 1;
    new_code := 'WAVE-' || upper(substr(translate(encode(gen_random_bytes(8), 'base64'), '+/=OIL01', 'ABCDEFGH'), 1, 4));
    BEGIN
      INSERT INTO public.rooms (code, created_by) VALUES (new_code, uid) RETURNING * INTO new_room;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF attempts > 10 THEN RAISE EXCEPTION 'CODE_GENERATION_FAILED'; END IF;
    END;
  END LOOP;
  INSERT INTO public.room_participants (room_id, user_id) VALUES (new_room.id, uid);
  RETURN json_build_object('id', new_room.id, 'code', new_room.code, 'status', new_room.status);
END;
$$;

-- JOIN ROOM
CREATE OR REPLACE FUNCTION public.join_room(p_code TEXT)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  uid UUID := auth.uid();
  target public.rooms;
  active_count INT;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  SELECT * INTO target FROM public.rooms WHERE upper(code) = upper(trim(p_code));
  IF target.id IS NULL THEN RAISE EXCEPTION 'ROOM_NOT_FOUND'; END IF;

  IF EXISTS (SELECT 1 FROM public.room_participants
             WHERE room_id = target.id AND user_id = uid AND left_at IS NULL) THEN
    RETURN json_build_object('id', target.id, 'code', target.code, 'status', target.status);
  END IF;

  SELECT count(*) INTO active_count FROM public.room_participants
    WHERE room_id = target.id AND left_at IS NULL;
  IF active_count >= 2 THEN RAISE EXCEPTION 'ROOM_FULL'; END IF;

  INSERT INTO public.room_participants (room_id, user_id) VALUES (target.id, uid);
  UPDATE public.rooms SET status = 'active' WHERE id = target.id;
  RETURN json_build_object('id', target.id, 'code', target.code, 'status', 'active');
END;
$$;

-- LEAVE ROOM
CREATE OR REPLACE FUNCTION public.leave_room(p_room_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  UPDATE public.room_participants SET left_at = now()
    WHERE room_id = p_room_id AND user_id = uid AND left_at IS NULL;
  UPDATE public.rooms SET status = 'ended'
    WHERE id = p_room_id
      AND NOT EXISTS (SELECT 1 FROM public.room_participants
                      WHERE room_id = p_room_id AND left_at IS NULL);
END;
$$;

-- ROOM STATE (participants + first names), members only
CREATE OR REPLACE FUNCTION public.get_room_state(p_room_id UUID)
RETURNS JSON LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE uid UUID := auth.uid(); result JSON;
BEGIN
  IF uid IS NULL OR NOT public.is_active_member(p_room_id, uid) THEN
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

GRANT EXECUTE ON FUNCTION public.create_room() TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_room(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_room(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_room_state(UUID) TO authenticated;
