export interface Clock {
  now(): Date;
  iso(): string;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  iso(): string {
    return this.now().toISOString();
  }
}

/** Frozen clock for replays and tests (`--now` / DEALERSOURCE_NOW). */
export class FixedClock implements Clock {
  constructor(private readonly at: Date) {}
  now(): Date {
    return new Date(this.at.getTime());
  }
  iso(): string {
    return this.at.toISOString();
  }
}

export function makeClock(now?: string | null): Clock {
  if (now && now.trim()) {
    const d = new Date(now);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid clock value: ${now}`);
    return new FixedClock(d);
  }
  return new SystemClock();
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function daysBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 86_400_000;
}

export function isExpired(expiresAt: string, nowIso: string): boolean {
  return new Date(expiresAt).getTime() <= new Date(nowIso).getTime();
}

/** Calendar day in America/New_York, used for "same day" idempotency. */
export function localDay(iso: string, timeZone = "America/New_York"): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(iso));
}
