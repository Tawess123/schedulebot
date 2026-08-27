import { getOverride, getSchools } from '../data/dataManager.js';
import { describeSlot } from '../shared/types.js';
import type {
  ClassSlot,
  SchedulePeriod,
  School,
  StatusResult,
  Student,
  Weekday,
  WeeklySchedule,
} from '../shared/types.js';

/**
 * Turns a student's timetable plus today's overrides into a display-ready
 * {@link StatusResult}. Pure with respect to time: every function takes the
 * "current" instant from the caller, so the whole engine is testable.
 */

const TIMEZONE = 'America/Toronto';

/** Wall-clock parts of an instant, as seen in {@link TIMEZONE}. */
interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const PART_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function zonedParts(date: Date): ZonedParts {
  const found: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of PART_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') found[part.type] = Number(part.value);
  }
  return {
    year: found.year ?? 0,
    month: found.month ?? 1,
    day: found.day ?? 1,
    // `h23` still reports midnight as 24 on some ICU builds.
    hour: (found.hour ?? 0) % 24,
    minute: found.minute ?? 0,
    second: found.second ?? 0,
  };
}

/** How far {@link TIMEZONE} is ahead of UTC at `date`, in milliseconds. */
function zoneOffsetMs(date: Date): number {
  const parts = zonedParts(date);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Drop sub-second precision on both sides so the difference is a clean offset.
  return asUtc - (date.getTime() - date.getMilliseconds());
}

/**
 * The instant at which the {@link TIMEZONE} wall clock reads `timeStr` (`HH:MM`)
 * on the same day as `reference`.
 *
 * `reference` defaults to now, so `parseTime('08:30')` means "08:30 today in
 * Toronto". Callers that already hold a `now` should pass it, so a status
 * computed for some other day compares against that day's clock.
 */
export function parseTime(timeStr: string, reference: Date = new Date()): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) {
    throw new Error(`Invalid HH:MM time "${timeStr}"`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Out-of-range HH:MM time "${timeStr}"`);
  }

  const today = zonedParts(reference);
  const wallClock = Date.UTC(today.year, today.month - 1, today.day, hours, minutes);

  // The offset depends on the instant we are solving for, so guess once using
  // the naive reading, then correct — which settles it across DST changes.
  let instant = wallClock - zoneOffsetMs(new Date(wallClock));
  instant = wallClock - zoneOffsetMs(new Date(instant));
  return new Date(instant);
}

/** Monday–Friday index for `date`, or `null` on a weekend. */
function weekdayOf(date: Date): Weekday | null {
  const parts = zonedParts(date);
  const dayOfWeek = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay(); // 0 = Sunday
  return dayOfWeek >= 1 && dayOfWeek <= 5 ? ((dayOfWeek - 1) as Weekday) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` for `date` as seen in {@link TIMEZONE}. */
function dateKey(date: Date): string {
  const parts = zonedParts(date);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

/**
 * UTC midnight of the Monday starting `date`'s week in {@link TIMEZONE}. Used
 * only for whole-week arithmetic, so a fixed UTC anchor is safe across DST.
 */
function mondayOf(date: Date): number {
  const parts = zonedParts(date);
  const midnight = Date.UTC(parts.year, parts.month - 1, parts.day);
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - daysSinceMonday * DAY_MS;
}

/** Same, for a `YYYY-MM-DD` string. Null when the string is not a date. */
function mondayOfKey(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.trim());
  if (!match) return null;

  const midnight = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  if (Number.isNaN(midnight)) return null;

  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - daysSinceMonday * DAY_MS;
}

/**
 * Which week of the student's rotation covers `now`, counting from
 * `cycleStart`. Always 0 for the usual single-week timetable.
 */
export function getWeekIndex(student: Student, now: Date): number {
  const total = 1 + (student.extraWeeks?.length ?? 0);
  if (total < 2) return 0;

  const anchor = student.cycleStart ? mondayOfKey(student.cycleStart) : null;
  if (anchor === null) return 0;

  const elapsed = Math.round((mondayOf(now) - anchor) / (7 * DAY_MS));
  return ((elapsed % total) + total) % total;
}

/**
 * The dated block covering `now`, if any. When blocks overlap, the one that
 * started most recently wins — that reads the way people think about it:
 * "from the 15th, my timetable changed".
 */
function periodFor(student: Student, now: Date): SchedulePeriod | null {
  const today = dateKey(now);

  let best: SchedulePeriod | null = null;
  for (const period of student.periods ?? []) {
    if (today < period.from || today > period.to) continue;
    if (!best || period.from > best.from) best = period;
  }
  return best;
}

/**
 * The weekly timetable in force on `now`: a dated block if one covers today,
 * otherwise the rotation, otherwise the default week.
 */
function weekScheduleFor(student: Student, now: Date): WeeklySchedule {
  const period = periodFor(student, now);
  if (period) return period.schedule;

  const index = getWeekIndex(student, now);
  if (index === 0) return student.schedule;
  return student.extraWeeks?.[index - 1] ?? student.schedule;
}

/** Which block covers `now`, for the panel and for debugging. Null if none. */
export function getActivePeriod(
  student: Student,
  now: Date,
): SchedulePeriod | null {
  return periodFor(student, now);
}

/** A class slot resolved to concrete instants for the day being evaluated. */
interface ResolvedSlot {
  slot: ClassSlot;
  start: Date;
  end: Date;
}

/**
 * First slot at or after `fromIndex` that has not been cancelled. Cancelled
 * classes are skipped because they are not something the student is waiting for.
 */
function nextRemaining(
  slots: ResolvedSlot[],
  fromIndex: number,
  cancelled: ReadonlySet<number>,
): ResolvedSlot | null {
  for (let i = Math.max(fromIndex, 0); i < slots.length; i += 1) {
    const candidate = slots[i];
    if (candidate && !cancelled.has(i)) return candidate;
  }
  return null;
}

function nextEventText(next: ResolvedSlot | null): string | undefined {
  if (!next) return undefined;
  return `Prochain cours à ${next.slot.startTime} — ${describeSlot(next.slot)}`;
}

function resolveSlots(daySlots: ClassSlot[], now: Date): ResolvedSlot[] {
  return daySlots.map((slot) => ({
    slot,
    start: parseTime(slot.startTime, now),
    end: parseTime(slot.endTime, now),
  }));
}

/**
 * Everything on the student's plate for the day containing `now`: the recurring
 * timetable for the week currently in rotation, plus any one-off events dated
 * today. Empty on a free day.
 *
 * The result is sorted by start time, and that order is what
 * `cancelledClasses` and `finishedClasses` index into.
 */
export function getTodaySlots(student: Student, now: Date): ClassSlot[] {
  const today = dateKey(now);
  const events = (student.events ?? []).filter((event) => event.date === today);
  // A trip or an exam day can wipe the regular timetable entirely.
  const replacesDay = events.some((event) => event.replacesDay);

  const weekday = weekdayOf(now);
  const recurring =
    weekday === null || replacesDay
      ? []
      : (weekScheduleFor(student, now)[weekday] ?? []);

  const slots: ClassSlot[] = [
    ...recurring,
    ...events.map((event) => ({
      startTime: event.startTime,
      endTime: event.endTime,
      course: event.course,
      room: event.room,
      location: event.location,
    })),
  ];

  // Merged days must be chronological: first/last-of-day, "which class am I in"
  // and the override indexes all assume ascending start times.
  return slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/**
 * Index of the class the student is sitting in at `now`, or `-1` when they are
 * between classes. End times are exclusive.
 */
export function getCurrentClassIndex(student: Student, now: Date): number {
  return resolveSlots(getTodaySlots(student, now), now).findIndex(
    (entry) => now >= entry.start && now < entry.end,
  );
}

/** Index of the next class starting after `now`, or `-1` if the day is done. */
export function getNextClassIndex(student: Student, now: Date): number {
  return resolveSlots(getTodaySlots(student, now), now).findIndex(
    (entry) => entry.start > now,
  );
}

/**
 * Status for one student at `now`.
 *
 * The day's slots come from {@link getTodaySlots}, already sorted, and that is
 * the order `cancelledClasses` and `finishedClasses` index into.
 *
 * `schoolName` is not needed to compute the status today (overrides are keyed by
 * student name alone); it is accepted so call sites read clearly and so
 * per-school rules can land here without a signature change.
 */
/**
 * Status for one student at `now`, with their shared location appended when
 * they are free. See {@link computeStatus} for the decision order.
 */
export function getStudentStatus(
  student: Student,
  schoolName: string,
  now: Date,
): StatusResult {
  const result = computeStatus(student, schoolName, now);

  // A spot only means something while the student is available; in class, the
  // timetable already says where they are.
  const spot = getOverride(student.name).spot?.trim();
  if (result.emoji !== '🟢' || !spot) return result;

  return { ...result, statusText: `${result.statusText} · 📍 ${spot}` };
}

function computeStatus(
  student: Student,
  schoolName: string,
  now: Date,
): StatusResult {
  const name = student.name;
  const override = getOverride(name);

  // 1. Away for the whole day.
  if (override.absentToday) {
    return { name, emoji: '🔴', statusText: "Absent aujourd'hui" };
  }

  // 2. Went home at the break.
  if (override.leftAtBreak) {
    const destination = override.destination?.trim();
    return {
      name,
      emoji: '🔴',
      statusText: destination
        ? `Parti à la pause (${destination})`
        : 'Parti à la pause',
    };
  }

  /**
   * "I'm staying at school until HH:MM" replaces the three *absent* statuses —
   * no classes today, before the first, after the last — but never a class in
   * progress, and never an explicit departure (cases 1 and 2 above).
   */
  const stayingAtSchool = (): StatusResult | null => {
    const until = override.stayingUntil?.trim();
    if (!until) return null;
    try {
      if (now >= parseTime(until, now)) return null;
    } catch {
      return null; // Malformed time: fall through to the normal status.
    }
    return { name, emoji: '🟢', statusText: `À l'école jusqu'à ${until}` };
  };

  // 3. Nothing scheduled — weekend, or an empty weekday.
  const daySlots = getTodaySlots(student, now);
  if (daySlots.length === 0) {
    return stayingAtSchool() ?? { name, emoji: '🔴', statusText: 'Pas là' };
  }

  const cancelled = new Set(override.cancelledClasses ?? []);
  const finished = new Set(override.finishedClasses ?? []);

  const slots = resolveSlots(daySlots, now);

  const firstSlot = slots[0];
  const lastSlot = slots[slots.length - 1];
  if (!firstSlot || !lastSlot) {
    return { name, emoji: '🔴', statusText: 'Pas là' };
  }

  // 4. The school day has not started.
  if (now < firstSlot.start) {
    return (
      stayingAtSchool() ?? {
        name,
        emoji: '🔴',
        statusText: `Pas là (avant ${firstSlot.slot.startTime})`,
      }
    );
  }

  // 5. The school day is over.
  if (now >= lastSlot.end) {
    return (
      stayingAtSchool() ?? {
        name,
        emoji: '🔴',
        statusText: `Pas là (depuis ${lastSlot.slot.endTime})`,
      }
    );
  }

  // 6. Inside a class slot. `end` is exclusive, so the minute a class ends the
  //    student counts as being in the gap that follows.
  const currentIndex = slots.findIndex(
    (entry) => now >= entry.start && now < entry.end,
  );
  const current = currentIndex === -1 ? undefined : slots[currentIndex];

  if (current) {
    if (cancelled.has(currentIndex)) {
      return { name, emoji: '🔴', statusText: 'Cours annulé' };
    }

    if (finished.has(currentIndex)) {
      return {
        name,
        emoji: '🟢',
        statusText: 'En pause (cours terminé)',
        nextEvent: nextEventText(nextRemaining(slots, currentIndex + 1, cancelled)),
      };
    }

    return {
      name,
      emoji: '🟡',
      // The class itself is the useful part when someone is busy: what it is
      // and where, not just when it ends.
      statusText: `En cours : ${describeSlot(current.slot)} · jusqu'à ${current.slot.endTime}`,
    };
  }

  // Between two classes: everything below describes the gap.
  const upcoming = nextRemaining(
    slots,
    slots.findIndex((entry) => entry.start > now),
    cancelled,
  );

  // 7. A note explaining the pause wins over the plain countdown.
  const pauseNote = override.pauseNote?.trim();
  if (pauseNote) {
    return {
      name,
      emoji: '🟢',
      statusText: `En pause: ${pauseNote}`,
      nextEvent: nextEventText(upcoming),
    };
  }

  // 8. Free until the next class. If every remaining class is cancelled there
  //    is no time left to name.
  return {
    name,
    emoji: '🟢',
    statusText: upcoming
      ? `En pause (jusqu'à ${upcoming.slot.startTime})`
      : 'En pause',
  };
}

/** Every student's status, grouped by the school they belong to. */
export function getAllStatuses(
  now: Date,
): { school: School; statuses: StatusResult[] }[] {
  return getSchools().map((school) => ({
    school,
    statuses: school.students.map((student) =>
      getStudentStatus(student, school.name, now),
    ),
  }));
}
