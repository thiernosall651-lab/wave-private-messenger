-- WAVE : « vu à … » (dernière activité) visible uniquement par la personne avec qui on partage une salle.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Appelée toutes les minutes par l'appli ouverte : met à jour sa propre dernière activité.
CREATE OR REPLACE FUNCTION public.touch_last_seen() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.profiles SET last_seen_at = now() WHERE id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.touch_last_seen() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_last_seen() TO authenticated;

-- Dernière activité de l'autre personne de la salle (réservé aux membres actifs de la salle).
CREATE OR REPLACE FUNCTION public.get_peer_last_seen(p_room_id uuid) RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); v timestamptz;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'NOT_AUTHENTICATED'; END IF;
  IF NOT private.is_active_member(p_room_id, uid) THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;
  SELECT max(p.last_seen_at) INTO v
    FROM public.room_participants rp JOIN public.profiles p ON p.id = rp.user_id
   WHERE rp.room_id = p_room_id AND rp.user_id <> uid;
  RETURN v;
END; $$;
REVOKE ALL ON FUNCTION public.get_peer_last_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_peer_last_seen(uuid) TO authenticated;
