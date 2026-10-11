CREATE OR REPLACE FUNCTION public.create_room()
 RETURNS json LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  uid UUID := auth.uid();
  new_code TEXT;
  new_room public.rooms;
  attempts INT := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  LOOP
    attempts := attempts + 1;
    new_code := 'WAVE-' || upper(substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/=OIL01', 'ABCDEFGH'), 1, 4));
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
$function$;
REVOKE ALL ON FUNCTION public.create_room() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_room() TO authenticated;