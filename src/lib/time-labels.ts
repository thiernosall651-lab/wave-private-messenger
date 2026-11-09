/** Libellés de dates façon WhatsApp : séparateurs de jour et « last seen ». */

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function daysAgo(d: Date, now: Date) {
  return Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Séparateur de jour : Today, Yesterday, nom du jour (7 derniers jours), puis date complète. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const n = daysAgo(d, now);
  if (n <= 0) return "Today";
  if (n === 1) return "Yesterday";
  if (n < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}

/** Sous-titre de l'en-tête quand l'ami est hors ligne. */
export function lastSeenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Offline";
  const d = new Date(iso);
  if (now.getTime() - d.getTime() < 120_000) return "Last seen just now";
  const n = daysAgo(d, now);
  if (n <= 0) return `Last seen today at ${clock(d)}`;
  if (n === 1) return `Last seen yesterday at ${clock(d)}`;
  return `Last seen ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Heure précise avec le jour : « Today 02:27 », « Yesterday 23:10 », « 2 Nov, 02:27 ». */
export function timeWithDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const n = daysAgo(d, now);
  if (n <= 0) return `Today ${clock(d)}`;
  if (n === 1) return `Yesterday ${clock(d)}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock(d)}`;
}
