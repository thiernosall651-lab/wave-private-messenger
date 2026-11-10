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

/** Heure de déconnexion affichée sous le nom, avec une formulation courte façon WhatsApp. */
export function lastSeenLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "Hors ligne";
  const d = new Date(iso);
  const n = daysAgo(d, now);
  if (n <= 0) return `Hors ligne à ${clock(d)}`;
  if (n === 1) return `Hors ligne hier à ${clock(d)}`;
  return `Hors ligne le ${d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  })} à ${clock(d)}`;
}

/** Heure précise avec le jour : « Today 02:27 », « Yesterday 23:10 », « 2 Nov, 02:27 ». */
export function timeWithDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const n = daysAgo(d, now);
  if (n <= 0) return `Today ${clock(d)}`;
  if (n === 1) return `Yesterday ${clock(d)}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${clock(d)}`;
}
