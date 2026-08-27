/**
 * Types shared between the Discord bot (src/bot), the web panel (src/web)
 * and the JSON persistence layer (src/data).
 */

/** Weekday index used everywhere in this project: 0 = Monday .. 4 = Friday. */
export type Weekday = 0 | 1 | 2 | 3 | 4;

/** French display names for {@link Weekday}. */
export const WEEKDAYS = {
  0: 'Lundi',
  1: 'Mardi',
  2: 'Mercredi',
  3: 'Jeudi',
  4: 'Vendredi',
} as const satisfies Record<Weekday, string>;

/**
 * One class in a student's day.
 *
 * A class needs a name, a room, or both — never neither. {@link location} is
 * the older single-label form kept so existing timetables keep working; it is
 * read as a fallback and replaced by `course`/`room` the next time the slot is
 * saved from the panel.
 */
export interface ClassSlot {
  /** Start of the class, 24h `HH:MM`. */
  startTime: string;
  /** End of the class, 24h `HH:MM`. */
  endTime: string;
  /** Course name, e.g. `Mathématiques`. Optional when {@link room} is set. */
  course?: string;
  /** Room code, e.g. `B2431`. Optional when {@link course} is set. */
  room?: string;
  /** @deprecated Legacy single label; use {@link course} and {@link room}. */
  location?: string;
}

/**
 * How a class reads on screen: `Maths (B2431)`, or just whichever half exists.
 * Shared by the bot, the engine and the panel so they never drift apart.
 */
export function describeSlot(slot: ClassSlot): string {
  const course = slot.course?.trim();
  // A legacy `location` stands in for the room when nothing better is set.
  const room = slot.room?.trim() || slot.location?.trim();

  if (course && room) return `${course} (${room})`;
  return course || room || 'Cours';
}

/** True when a slot carries at least one of the two labels. */
export function hasSlotLabel(slot: ClassSlot): boolean {
  return Boolean(
    slot.course?.trim() || slot.room?.trim() || slot.location?.trim(),
  );
}

/**
 * A student's recurring week. Every weekday key is expected to be present;
 * a day with no classes is an empty array.
 */
export type WeeklySchedule = Record<Weekday, ClassSlot[]>;

/**
 * A one-off class or activity on a specific date — an exam, a field trip, a
 * make-up lecture. Merged into whatever the recurring timetable says for that
 * day, unless {@link replacesDay} is set.
 */
export interface DatedEvent extends ClassSlot {
  /** `YYYY-MM-DD` in the school timezone. */
  date: string;
  /** Ignore the recurring timetable that day and use only the events. */
  replacesDay?: boolean;
}

/**
 * A weekly pattern that only applies between two dates.
 *
 * This is the answer to timetables that do not repeat: two quiet weeks, then a
 * block of two-day weeks, then a three-day week. Each block is a period, and
 * periods win over the default week for the dates they cover.
 */
export interface SchedulePeriod {
  /** First day the pattern applies, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Last day the pattern applies, `YYYY-MM-DD`, inclusive. */
  to: string;
  /** Optional name shown in the panel, e.g. `Rentrée` or `Stage`. */
  label?: string;
  schedule: WeeklySchedule;
}

export interface Student {
  name: string;
  /** Discord user id, when the student is linked to an account. */
  discordId?: string;
  /**
   * Week 1 of the rotation, and the entire timetable when {@link extraWeeks}
   * is empty — which is the common case.
   */
  schedule: WeeklySchedule;
  /**
   * Weeks 2…N of a rotating timetable (A/B weeks and longer cycles). Requires
   * {@link cycleStart} to know which week is which.
   */
  extraWeeks?: WeeklySchedule[];
  /** The Monday (`YYYY-MM-DD`) on which week 1 of the rotation starts. */
  cycleStart?: string;
  /**
   * Date-bounded weekly patterns. Checked before {@link extraWeeks} and
   * {@link schedule}; when several cover the same day, the one that started
   * most recently wins.
   */
  periods?: SchedulePeriod[];
  /** One-off events, merged into the day they fall on. */
  events?: DatedEvent[];
}

export interface School {
  name: string;
  /** Image shown as the embed banner. */
  bannerUrl?: string;
  /** Image shown as the embed thumbnail. */
  thumbnailUrl?: string;
  /** Embed accent colour, `#RRGGBB`. */
  colorHex: string;
  /**
   * Common meeting spots offered when a student shares where they are —
   * `Cafétéria`, `Bibliothèque`, `Agora`. Free text is always allowed too.
   */
  places?: string[];
  students: Student[];
}

/**
 * One-off adjustments applied to a single student for the current day.
 * Every field is optional — an override only carries what changed.
 */
export interface StudentOverride {
  /** The student is not at school at all today. */
  absentToday?: boolean;
  /** The student went home at the break instead of staying. */
  leftAtBreak?: boolean;
  /** Where the student went, e.g. `Maison`. */
  destination?: string;
  /** Free-text note explaining the pause. */
  pauseNote?: string;
  /**
   * Staying at school until this `HH:MM`, even once the timetable says the day
   * is over. Overrides the "not here" statuses, never an actual class.
   */
  stayingUntil?: string;
  /**
   * Where the student is right now, so friends can find them. Only rendered
   * while they are free — in class, where they sit is the timetable's job.
   */
  spot?: string;
  /** Indexes into the day's {@link ClassSlot} array that were cancelled. */
  cancelledClasses?: number[];
  /** Indexes into the day's {@link ClassSlot} array that are already over. */
  finishedClasses?: number[];
}

/** Today's overrides, keyed by {@link Student.name}. */
export type OverrideStore = Record<string, StudentOverride>;

/** Traffic-light indicator for a student's current availability. */
export type StatusEmoji = '🔴' | '🟡' | '🟢';

/** Computed, display-ready status for one student. */
export interface StatusResult {
  name: string;
  emoji: StatusEmoji;
  /** Human-readable status line, e.g. `En cours jusqu'à 16:00`. */
  statusText: string;
  /** What happens next, when there is something after the current slot. */
  nextEvent?: string;
}

/* -------------------------------------------------------------------------- */
/* Infrastructure                                                             */
/* -------------------------------------------------------------------------- */

/** Environment-derived configuration (see `.env.example`). */
export interface AppConfig {
  discordToken: string;
  channelId: string;
  pauseRoleId: string;
  webPort: number;
  webSecret: string;
}

/** Envelope used by every web panel API response. */
export type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };
