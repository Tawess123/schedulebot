import { readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type {
  OverrideStore,
  School,
  Student,
  StudentOverride,
} from '../shared/types.js';

/**
 * Single source of truth for everything the bot and the web panel persist.
 *
 * State lives in memory; readers are synchronous so callers never have to
 * await a schedule lookup. Mutations update memory immediately and flush to
 * disk in the background through {@link queueWrite}.
 */

/**
 * Both `src/data` (ts-node) and `dist/data` (compiled) sit two levels below the
 * project root, so this always resolves to the checked-in `src/data` directory.
 */
const DATA_DIR = path.resolve(__dirname, '..', '..', 'src', 'data');
const SCHOOLS_PATH = path.join(DATA_DIR, 'schools.json');
const OVERRIDES_PATH = path.join(DATA_DIR, 'overrides.json');

/** Overrides are scoped to a school day in this timezone. */
const TIMEZONE = 'America/Toronto';

/** On-disk shape of `overrides.json`. */
interface OverridesFile {
  /** `YYYY-MM-DD` in {@link TIMEZONE} — the day these overrides belong to. */
  date: string;
  overrides: OverrideStore;
  /**
   * Discord message id of each school's status embed, keyed by school name.
   * Lives here so the bot can edit the same messages after a restart. Not
   * per-day data, so the daily reset deliberately leaves it alone.
   */
  messageIds: Record<string, string>;
}

let schools: School[] = [];
let overrides: OverrideStore = {};
let overridesDate: string = todayInTimezone();
let statusMessageIds: Record<string, string> = {};

/** Serialises background writes so two flushes can't interleave on one file. */
const writeQueues = new Map<string, Promise<void>>();

/** `YYYY-MM-DD` for the current moment in {@link TIMEZONE}. */
function todayInTimezone(): string {
  // `en-CA` formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Write through a temp file and rename over the target. `rename` is atomic, so
 * a crash mid-write leaves the previous file intact instead of a truncated one
 * that would fail to parse on the next boot.
 */
async function writeAtomic(filePath: string, data: unknown): Promise<void> {
  const temp = `${filePath}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(temp, filePath);
}

/**
 * Flush `data` to `filePath` after any write already pending for that file.
 * Failures are logged rather than thrown: callers are synchronous and a failed
 * flush must not take the bot down.
 */
function queueWrite(filePath: string, data: unknown): void {
  const previous = writeQueues.get(filePath) ?? Promise.resolve();
  const next = previous
    .then(() => writeAtomic(filePath, data))
    .catch((err: unknown) => {
      console.error(`[dataManager] failed to write ${filePath}:`, err);
    });
  writeQueues.set(filePath, next);
}

/** Resolve when every queued write has settled — useful on shutdown. */
export async function flushPendingWrites(): Promise<void> {
  await Promise.all([...writeQueues.values()]);
}

/**
 * Read both files into memory. Missing or malformed files fall back to empty
 * defaults so a fresh checkout still boots.
 */
export async function loadAll(): Promise<void> {
  schools = await readSchools();

  const file = await readOverrides();
  overridesDate = file.date;
  overrides = file.overrides;
  statusMessageIds = file.messageIds;

  resetDailyOverridesIfNeeded();
  loaded = true;
}

let loaded = false;
let loading: Promise<void> | null = null;

/**
 * Load once, no matter how many entry points ask. The bot and the web server
 * can run in the same process, and a second {@link loadAll} would throw away
 * in-memory state that has not finished flushing yet.
 */
export async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loading ??= loadAll().finally(() => {
    loading = null;
  });
  await loading;
}

/**
 * Read the schools config.
 *
 * A missing file is a normal first run and yields an empty list. Anything else
 * — unreadable, malformed, not an array — throws instead of falling back to
 * `[]`: an empty in-memory list would be written straight back over the real
 * file by the next mutation, turning a transient read failure into permanent
 * data loss.
 */
async function readSchools(): Promise<School[]> {
  let raw: string;
  try {
    raw = await readFile(SCHOOLS_PATH, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.warn(`[dataManager] ${SCHOOLS_PATH} not found — starting empty`);
      return [];
    }
    throw new Error(`Could not read ${SCHOOLS_PATH}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(
      `${SCHOOLS_PATH} is not valid JSON (${String(err)}). Refusing to start so ` +
        'the file is not overwritten — restore it from schools.json.example or a backup.',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${SCHOOLS_PATH} must contain an array of schools`);
  }
  return parsed as School[];
}

async function readOverrides(): Promise<OverridesFile> {
  const empty: OverridesFile = {
    date: todayInTimezone(),
    overrides: {},
    messageIds: {},
  };
  try {
    const parsed: unknown = JSON.parse(await readFile(OVERRIDES_PATH, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return empty;

    const {
      date,
      overrides: stored,
      messageIds,
    } = parsed as Partial<OverridesFile>;
    return {
      date: typeof date === 'string' ? date : empty.date,
      overrides:
        typeof stored === 'object' && stored !== null ? stored : {},
      messageIds:
        typeof messageIds === 'object' && messageIds !== null ? messageIds : {},
    };
  } catch (err: unknown) {
    // A missing file is the normal first-run case, so only log the rest.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`[dataManager] failed to read ${OVERRIDES_PATH}:`, err);
    }
    return empty;
  }
}

function persistOverrides(): void {
  const file: OverridesFile = {
    date: overridesDate,
    overrides,
    messageIds: statusMessageIds,
  };
  queueWrite(OVERRIDES_PATH, file);
}

/* -------------------------------------------------------------------------- */
/* Status message ids                                                         */
/* -------------------------------------------------------------------------- */

/** Status embed message ids, keyed by school name. */
export function getStatusMessageIds(): Record<string, string> {
  return { ...statusMessageIds };
}

/** Remember the message id carrying a school's status embed. */
export function setStatusMessageId(schoolName: string, messageId: string): void {
  if (statusMessageIds[schoolName] === messageId) return;
  statusMessageIds[schoolName] = messageId;
  persistOverrides();
}

/** Forget a school's status message — call this when the message is gone. */
export function clearStatusMessageId(schoolName: string): void {
  if (!(schoolName in statusMessageIds)) return;
  delete statusMessageIds[schoolName];
  persistOverrides();
}

/* -------------------------------------------------------------------------- */
/* Schools                                                                    */
/* -------------------------------------------------------------------------- */

export function getSchools(): School[] {
  return schools;
}

export function getStudentByDiscordId(
  id: string,
): { student: Student; school: School } | null {
  for (const school of schools) {
    for (const student of school.students) {
      if (student.discordId === id) return { student, school };
    }
  }
  return null;
}

function findSchool(schoolName: string): School | undefined {
  return schools.find((school) => school.name === schoolName);
}

export function addSchool(school: School): void {
  if (findSchool(school.name)) {
    throw new Error(`School "${school.name}" already exists`);
  }
  schools.push(school);
  saveSchools();
}

/**
 * Drop optional fields that are present but empty. Keeps schools.json readable
 * and makes "clear the rotation" work: the API sends `extraWeeks: []`, which
 * has to survive the merge as a key and then disappear here.
 */
function pruneStudent(student: Student): Student {
  const next: Student = { ...student };
  if (!next.discordId) delete next.discordId;
  if (!next.extraWeeks?.length) delete next.extraWeeks;
  if (!next.cycleStart) delete next.cycleStart;
  if (!next.periods?.length) delete next.periods;
  if (!next.events?.length) delete next.events;
  return next;
}

export function addStudent(schoolName: string, student: Student): void {
  const school = findSchool(schoolName);
  if (!school) throw new Error(`Unknown school "${schoolName}"`);

  if (school.students.some((existing) => existing.name === student.name)) {
    throw new Error(`Student "${student.name}" already exists in "${schoolName}"`);
  }
  school.students.push(pruneStudent(student));
  saveSchools();
}

/**
 * Edit a student in place. Kept separate from remove + add because that pair
 * would drop today's override and move the student to the end of the list.
 */
export function updateStudent(
  schoolName: string,
  studentName: string,
  patch: Partial<Student>,
): Student {
  const school = findSchool(schoolName);
  if (!school) throw new Error(`Unknown school "${schoolName}"`);

  const index = school.students.findIndex((s) => s.name === studentName);
  const current = index === -1 ? undefined : school.students[index];
  if (!current) {
    throw new Error(`Unknown student "${studentName}" in "${schoolName}"`);
  }

  const nextName = patch.name?.trim() || current.name;
  const clashes = school.students.some(
    (other, i) => i !== index && other.name === nextName,
  );
  if (clashes) {
    throw new Error(`Student "${nextName}" already exists in "${schoolName}"`);
  }

  const updated = pruneStudent({ ...current, ...patch, name: nextName });

  school.students[index] = updated;
  saveSchools();

  if (nextName !== current.name) {
    const carried = overrides[current.name];
    if (carried) {
      overrides[nextName] = carried;
      delete overrides[current.name];
      persistOverrides();
    }
  }

  return updated;
}

/**
 * Edit a school's identity and embed styling in place. Renaming carries the
 * status message id across, so the bot keeps editing the same Discord message
 * instead of posting a duplicate.
 */
export function updateSchool(
  schoolName: string,
  patch: Partial<Omit<School, 'students'>>,
): School {
  const school = findSchool(schoolName);
  if (!school) throw new Error(`Unknown school "${schoolName}"`);

  const nextName = patch.name?.trim() || school.name;
  const clashes = schools.some(
    (other) => other !== school && other.name === nextName,
  );
  if (clashes) throw new Error(`School "${nextName}" already exists`);

  school.name = nextName;
  if (patch.colorHex !== undefined) school.colorHex = patch.colorHex;

  // An empty string means "remove the image", not "store an empty url".
  if (patch.bannerUrl !== undefined) {
    if (patch.bannerUrl) school.bannerUrl = patch.bannerUrl;
    else delete school.bannerUrl;
  }
  if (patch.thumbnailUrl !== undefined) {
    if (patch.thumbnailUrl) school.thumbnailUrl = patch.thumbnailUrl;
    else delete school.thumbnailUrl;
  }

  if (nextName !== schoolName) {
    const messageId = statusMessageIds[schoolName];
    if (messageId) {
      statusMessageIds[nextName] = messageId;
      delete statusMessageIds[schoolName];
      persistOverrides();
    }
  }

  saveSchools();
  return school;
}

/** Drop a school along with its students' overrides and its status message. */
export function removeSchool(schoolName: string): void {
  const index = schools.findIndex((school) => school.name === schoolName);
  if (index === -1) throw new Error(`Unknown school "${schoolName}"`);

  const [removed] = schools.splice(index, 1);
  saveSchools();

  for (const student of removed?.students ?? []) {
    clearOverride(student.name);
  }
  // The embed in Discord is now orphaned; forgetting the id stops us editing it.
  clearStatusMessageId(schoolName);
}

export function removeStudent(schoolName: string, studentName: string): void {
  const school = findSchool(schoolName);
  if (!school) throw new Error(`Unknown school "${schoolName}"`);

  const index = school.students.findIndex((s) => s.name === studentName);
  if (index === -1) return;

  school.students.splice(index, 1);
  saveSchools();

  // The student's day no longer exists, so neither should their override.
  clearOverride(studentName);
}

export function saveSchools(): void {
  queueWrite(SCHOOLS_PATH, schools);
}

/* -------------------------------------------------------------------------- */
/* Overrides                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Drop every override once the school day rolls over. Cheap enough to call
 * from any override accessor, and also exposed for a scheduled midnight run.
 */
export function resetDailyOverridesIfNeeded(): void {
  const today = todayInTimezone();
  if (overridesDate === today) return;

  overridesDate = today;
  overrides = {};
  persistOverrides();
}

/** Every override set today, keyed by student name. */
export function getAllOverrides(): OverrideStore {
  resetDailyOverridesIfNeeded();
  return { ...overrides };
}

/** Today's override for a student — an empty object when nothing is set. */
export function getOverride(studentName: string): StudentOverride {
  resetDailyOverridesIfNeeded();
  // Copied so callers can't mutate the store without going through setOverride.
  return { ...overrides[studentName] };
}

/** Merge `override` into the student's existing override for today. */
export function setOverride(
  studentName: string,
  override: Partial<StudentOverride>,
): void {
  resetDailyOverridesIfNeeded();
  overrides[studentName] = { ...overrides[studentName], ...override };
  persistOverrides();
}

export function clearOverride(studentName: string): void {
  resetDailyOverridesIfNeeded();
  if (!(studentName in overrides)) return;

  delete overrides[studentName];
  persistOverrides();
}
