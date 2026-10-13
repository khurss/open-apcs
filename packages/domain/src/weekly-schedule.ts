export interface WeeklySettings { zone: string; days: number[]; startMinute: number; endMinute: number; }
const DAY = 86400000;
const MIN_WALL = Date.UTC(1900, 0, 1);
const MAX_WALL = Date.UTC(2101, 0, 1);
function formatter(zone: string) {
  return new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}
export function validateWeeklySettings(input: unknown): WeeklySettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid weekly schedule settings');
  const s = input as Record<string, unknown>;
  if (Object.keys(s).some((key) => !['zone', 'days', 'startMinute', 'endMinute'].includes(key)) || typeof s.zone !== 'string' || s.zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(s.zone)) throw new Error('Invalid schedule zone or fields');
  try { formatter(s.zone); } catch { throw new Error('Unknown schedule time zone'); }
  if (!Array.isArray(s.days) || !s.days.length || s.days.length > 7 || new Set(s.days).size !== s.days.length || s.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new Error('Schedule weekdays must be unique integers from 1 to 7');
  for (const key of ['startMinute', 'endMinute']) if (!Number.isInteger(s[key]) || (s[key] as number) < 0 || (s[key] as number) > 1439) throw new Error('Schedule boundaries must be minutes from 0 to 1439');
  return structuredClone(input) as WeeklySettings;
}
/** Weekly level windows. Missing boundaries skip a window; repeated boundaries use the first occurrence. */
export class WeeklySchedule {
  private readonly settings: WeeklySettings;
  private readonly format: Intl.DateTimeFormat;
  private anchor: { mono: number; wall: number } | undefined;
  private lastMono = 0;
  private faulted = false;
  private cachedDay: number | undefined;
  private intervals: Array<[number, number]> = [];
  constructor(settings: WeeklySettings) { this.settings = validateWeeklySettings(settings); this.format = formatter(this.settings.zone); }
  private localStamp(epoch: number): number {
    const parts = Object.fromEntries(this.format.formatToParts(epoch).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  }
  private boundary(day: number, minute: number): number | undefined {
    const target = day + minute * 60000;
    // Probe both sides of the local day; validate every candidate by formatting it back.
    const offsets = new Set([-36, -12, 0, 12, 36].map((hours) => { const epoch = target + hours * 3600000; return this.localStamp(epoch) - epoch; }));
    const candidates = [...offsets].map((offset) => target - offset).filter((epoch) => this.localStamp(epoch) === target);
    return candidates.length ? Math.min(...candidates) : undefined;
  }
  step(monotonicMs: number, wallMs: number): boolean {
    if (this.faulted) throw new Error('Schedule clock fault requires reactivation');
    if (!Number.isFinite(monotonicMs) || monotonicMs < this.lastMono || !Number.isFinite(wallMs) || wallMs < MIN_WALL || wallMs >= MAX_WALL || (this.anchor && Math.abs((wallMs - this.anchor.wall) - (monotonicMs - this.anchor.mono)) > 1000)) {
      this.faulted = true; throw new Error('Schedule clock is invalid or diverged by more than 1000 ms');
    }
    this.anchor ??= { mono: monotonicMs, wall: wallMs }; this.lastMono = monotonicMs;
    const day = Math.floor(this.localStamp(wallMs) / DAY) * DAY;
    if (day !== this.cachedDay) {
      const intervals: Array<[number, number]> = [];
      for (const startDay of [day - DAY, day]) {
        if (!this.settings.days.includes(new Date(startDay).getUTCDay() || 7)) continue;
        const start = this.boundary(startDay, this.settings.startMinute);
        const end = this.boundary(startDay + (this.settings.endMinute <= this.settings.startMinute ? DAY : 0), this.settings.endMinute);
        if (start !== undefined && end !== undefined && end > start) intervals.push([start, end]);
      }
      this.cachedDay = day; this.intervals = intervals;
    }
    return this.intervals.some(([start, end]) => wallMs >= start && wallMs < end);
  }
}
