export function fmtClock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function fmtNum(x: number, digits = 1): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "–";
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function fmtDate(iso: string): string {
  return dateFmt.format(new Date(`${iso}T00:00:00Z`));
}

export function fmtAltitude(alt: string): string {
  return /^\d+$/.test(alt) ? `${alt} m` : `${alt.replaceAll("-", "–")} m`;
}
