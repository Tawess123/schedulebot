import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import * as path from 'node:path';

import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import * as dotenv from 'dotenv';

import {
  addSchool,
  addStudent,
  clearOverride,
  ensureLoaded,
  getAllOverrides,
  getSchools,
  removeSchool,
  removeStudent,
  updateSchool,
  setOverride,
  updateStudent,
} from '../data/dataManager.js';
import { rescheduleClassUpdates, triggerUpdate } from '../bot/discordBot.js';
import { getAllStatuses } from '../bot/statusEngine.js';
import type {
  ClassSlot,
  DatedEvent,
  SchedulePeriod,
  School,
  Student,
  StudentOverride,
  WeeklySchedule,
} from '../shared/types.js';
import { verifyStudentToken } from '../shared/studentToken.js';
import type { StudentTokenClaims } from '../shared/studentToken.js';

/**
 * Admin API behind the web panel. Every `/api` route is bearer-authenticated
 * with `WEB_SECRET`; mutations go through dataManager and then ask the bot to
 * redraw its embeds, so the panel and Discord never disagree for long.
 */

/** Both `src/web` and `dist/web` sit two levels below the project root. */
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'src', 'web', 'public');
const PANEL_HTML = path.join(PUBLIC_DIR, 'index.html');

const DEFAULT_PORT = 3000;

/** The five weekday keys a {@link Student.schedule} must carry. */
const WEEKDAY_KEYS = [0, 1, 2, 3, 4] as const;

const TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Longest rotation we accept, to keep the editor and the payload sane. */
const MAX_CYCLE_WEEKS = 6;

/**
 * Validate a banner or thumbnail URL.
 *
 * Any raster format Discord can proxy is fine — png, jpg, gif, webp — and the
 * extension is not checked, because plenty of CDN links have none. Two cases
 * are rejected outright because they fail silently otherwise: a non-http URL,
 * and SVG, which Discord's image proxy does not render in embeds. Better a
 * clear error here than a blank space in the channel.
 */
function validateImageUrl(field: string, value: string): string | null {
  if (!value) return null; // Empty means "remove the image".

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `"${field}" must be a full URL starting with https://`;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `"${field}" must be an http(s) URL`;
  }
  if (parsed.pathname.toLowerCase().endsWith('.svg')) {
    return `Discord n'affiche pas les SVG dans les embeds — utilise un png, jpg, gif ou webp pour "${field}"`;
  }

  return null;
}

let webSecret = '';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ ok: false, error });
}

/** Constant-time string compare, so a wrong secret leaks nothing by timing. */
function secretMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(webSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Bearer auth for the API. Static assets are deliberately left open — a browser
 * cannot attach an Authorization header to its own page load, so gating them
 * would make the panel unreachable. The panel's HTML/JS is a shell; the data
 * behind it is what this protects.
 */
export const checkAuth: RequestHandler = (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    fail(res, 401, 'Missing bearer token');
    return;
  }
  if (!secretMatches(token)) {
    fail(res, 401, 'Invalid bearer token');
    return;
  }
  next();
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isClassSlot(value: unknown): value is ClassSlot {
  if (typeof value !== 'object' || value === null) return false;
  const slot = value as Partial<ClassSlot>;

  // Times are validated here rather than at render time: a bad one would
  // otherwise throw inside the embed loop and blank the whole channel.
  const timesOk =
    typeof slot.startTime === 'string' &&
    TIME_PATTERN.test(slot.startTime) &&
    typeof slot.endTime === 'string' &&
    TIME_PATTERN.test(slot.endTime);

  // A course name, a room, or both — but not an unlabelled block of time.
  const labelled =
    isNonEmptyString(slot.course) ||
    isNonEmptyString(slot.room) ||
    isNonEmptyString(slot.location);

  return timesOk && labelled;
}

/** Keep only the fields we store, dropping blanks and the legacy label. */
function normaliseSlot(slot: ClassSlot): ClassSlot {
  const out: ClassSlot = { startTime: slot.startTime, endTime: slot.endTime };

  const course = slot.course?.trim();
  const room = slot.room?.trim();
  if (course) out.course = course;
  if (room) out.room = room;

  // Neither given: keep the legacy single label rather than guessing which of
  // the two it was. The panel splits it the next time a human edits the slot.
  const legacy = slot.location?.trim();
  if (!course && !room && legacy) out.location = legacy;

  return out;
}

/** Validate one week: five weekday keys, each an array of slots. */
function parseWeek(raw: unknown, label: string): WeeklySchedule | string {
  const source = (raw ?? {}) as Record<string, unknown>;
  const week = {} as WeeklySchedule;

  for (const day of WEEKDAY_KEYS) {
    const slots = source[String(day)] ?? source[day];
    if (slots === undefined) {
      week[day] = [];
      continue;
    }
    if (!Array.isArray(slots) || !slots.every(isClassSlot)) {
      return `"${label}.${day}" must be an array of slots with HH:MM times and a course or a room`;
    }
    week[day] = slots.map(normaliseSlot);
  }

  return week;
}

function parseExtraWeeks(raw: unknown): WeeklySchedule[] | string {
  if (!Array.isArray(raw)) return '"extraWeeks" must be an array of weeks';
  if (raw.length > MAX_CYCLE_WEEKS - 1) {
    return `a rotation can span at most ${MAX_CYCLE_WEEKS} weeks`;
  }

  const weeks: WeeklySchedule[] = [];
  for (const [index, week] of raw.entries()) {
    const parsed = parseWeek(week, `extraWeeks[${index}]`);
    if (typeof parsed === 'string') return parsed;
    weeks.push(parsed);
  }
  return weeks;
}

function parsePeriods(raw: unknown): SchedulePeriod[] | string {
  if (!Array.isArray(raw)) return '"periods" must be an array';

  const periods: SchedulePeriod[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) {
      return `"periods[${index}]" must be an object`;
    }
    const input = item as Partial<SchedulePeriod>;

    const from = typeof input.from === 'string' ? input.from.trim() : '';
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    if (!DATE_PATTERN.test(from) || !DATE_PATTERN.test(to)) {
      return `"periods[${index}]" needs from and to as YYYY-MM-DD`;
    }
    if (to < from) {
      return `"periods[${index}]" ends before it starts`;
    }

    const schedule = parseWeek(input.schedule, `periods[${index}].schedule`);
    if (typeof schedule === 'string') return schedule;

    const period: SchedulePeriod = { from, to, schedule };
    if (isNonEmptyString(input.label)) period.label = input.label.trim();
    periods.push(period);
  }

  periods.sort((a, b) => a.from.localeCompare(b.from));
  return periods;
}

function parseEvents(raw: unknown): DatedEvent[] | string {
  if (!Array.isArray(raw)) return '"events" must be an array';

  const events: DatedEvent[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null) {
      return `"events[${index}]" must be an object`;
    }
    // Read the event-only fields before the type guard narrows `item` to a slot.
    const input = item as Partial<DatedEvent>;
    const date = typeof input.date === 'string' ? input.date.trim() : '';
    const replacesDay = input.replacesDay === true;

    if (!DATE_PATTERN.test(date)) {
      return `"events[${index}].date" must be YYYY-MM-DD`;
    }
    if (!isClassSlot(item)) {
      return `"events[${index}]" needs startTime, endTime (HH:MM) and a course or a room`;
    }

    const event: DatedEvent = { date, ...normaliseSlot(item) };
    if (replacesDay) event.replacesDay = true;
    events.push(event);
  }

  events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  );
  return events;
}

/** Shared by create and patch: the optional rotation / events fields. */
function applyPlanFields(
  input: Partial<Student>,
  target: Partial<Student>,
): string | null {
  // Empty values are assigned rather than omitted: on a PATCH the key has to be
  // present for the merge to see it, and dataManager prunes empties on save.
  if (input.extraWeeks !== undefined) {
    const parsed = parseExtraWeeks(input.extraWeeks);
    if (typeof parsed === 'string') return parsed;
    target.extraWeeks = parsed;
  }

  if (input.cycleStart !== undefined) {
    const value = String(input.cycleStart).trim();
    if (value && !DATE_PATTERN.test(value)) {
      return '"cycleStart" must be YYYY-MM-DD';
    }
    target.cycleStart = value;
  }

  if (input.periods !== undefined) {
    const parsed = parsePeriods(input.periods);
    if (typeof parsed === 'string') return parsed;
    target.periods = parsed;
  }

  if (input.events !== undefined) {
    const parsed = parseEvents(input.events);
    if (typeof parsed === 'string') return parsed;
    target.events = parsed;
  }

  return null;
}

/**
 * Validate an incoming student and normalise its schedule so every weekday key
 * exists — the rest of the app indexes `schedule[0..4]` without checking.
 */
function parseStudent(body: unknown): Student | string {
  if (typeof body !== 'object' || body === null) return 'Body must be an object';

  const input = body as Partial<Student>;
  if (!isNonEmptyString(input.name)) return '"name" is required';
  if (input.discordId !== undefined && typeof input.discordId !== 'string') {
    return '"discordId" must be a string';
  }

  const schedule = parseWeek(input.schedule, 'schedule');
  if (typeof schedule === 'string') return schedule;

  const student: Student = { name: input.name.trim(), schedule };
  if (input.discordId) student.discordId = input.discordId.trim();

  const problem = applyPlanFields(input, student);
  if (problem) return problem;

  return student;
}

/** Validate a partial student edit — only the fields actually present. */
function parseStudentPatch(body: unknown): Partial<Student> | string {
  if (typeof body !== 'object' || body === null) return 'Body must be an object';

  const input = body as Partial<Student>;
  const patch: Partial<Student> = {};

  if (input.name !== undefined) {
    if (!isNonEmptyString(input.name)) return '"name" must be a non-empty string';
    patch.name = input.name.trim();
  }

  if (input.discordId !== undefined) {
    if (typeof input.discordId !== 'string') return '"discordId" must be a string';
    patch.discordId = input.discordId.trim();
  }

  if (input.schedule !== undefined) {
    const parsed = parseWeek(input.schedule, 'schedule');
    if (typeof parsed === 'string') return parsed;
    patch.schedule = parsed;
  }

  // `undefined` on these means "leave alone"; an empty array/string clears them,
  // and applyPlanFields assigns either way so the key reaches the merge.
  const problem = applyPlanFields(input, patch);
  if (problem) return problem;

  if (Object.keys(patch).length === 0) return 'Nothing to update';
  return patch;
}

/** Meeting spots offered by the position picker; deduplicated, order kept. */
function parsePlaces(raw: unknown): string[] | string {
  if (!Array.isArray(raw)) return '"places" must be an array of strings';

  const places: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return '"places" must be an array of strings';
    const value = item.trim();
    if (!value || places.includes(value)) continue;
    places.push(value.slice(0, 100));
  }
  return places;
}

function parseSchool(body: unknown): School | string {
  if (typeof body !== 'object' || body === null) return 'Body must be an object';

  const input = body as Partial<School>;
  if (!isNonEmptyString(input.name)) return '"name" is required';
  if (!isNonEmptyString(input.colorHex)) return '"colorHex" is required';
  if (!/^#?[0-9a-f]{6}$/i.test(input.colorHex.trim())) {
    return '"colorHex" must be a hex colour like #005EB8';
  }

  const school: School = {
    name: input.name.trim(),
    colorHex: input.colorHex.trim(),
    students: [],
  };
  for (const field of ['bannerUrl', 'thumbnailUrl'] as const) {
    if (!isNonEmptyString(input[field])) continue;
    const value = input[field].trim();
    const problem = validateImageUrl(field, value);
    if (problem) return problem;
    school[field] = value;
  }
  if (input.places !== undefined) {
    const parsed = parsePlaces(input.places);
    if (typeof parsed === 'string') return parsed;
    if (parsed.length) school.places = parsed;
  }
  return school;
}

/** Validate a partial school edit — only the fields actually present. */
function parseSchoolPatch(body: unknown): Partial<School> | string {
  if (typeof body !== 'object' || body === null) return 'Body must be an object';

  const input = body as Partial<School>;
  const patch: Partial<School> = {};

  if (input.name !== undefined) {
    if (!isNonEmptyString(input.name)) return '"name" must be a non-empty string';
    patch.name = input.name.trim();
  }

  if (input.colorHex !== undefined) {
    if (
      !isNonEmptyString(input.colorHex) ||
      !/^#?[0-9a-f]{6}$/i.test(input.colorHex.trim())
    ) {
      return '"colorHex" must be a hex colour like #005EB8';
    }
    patch.colorHex = input.colorHex.trim();
  }

  for (const field of ['bannerUrl', 'thumbnailUrl'] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string') return `"${field}" must be a string`;

    const value = input[field].trim();
    const problem = validateImageUrl(field, value);
    if (problem) return problem;
    patch[field] = value;
  }

  if (input.places !== undefined) {
    const parsed = parsePlaces(input.places);
    if (typeof parsed === 'string') return parsed;
    patch.places = parsed;
  }

  if (Object.keys(patch).length === 0) return 'Nothing to update';
  return patch;
}

function findSchool(name: string): School | undefined {
  return getSchools().find((school) => school.name === name);
}

/**
 * Run a dataManager mutation and redraw Discord. dataManager throws on unknown
 * names and duplicates, which maps cleanly onto a 4xx.
 *
 * Pass `reschedule` for anything that can change class times: the bot's cron
 * jobs are built from the timetables, so a new student would otherwise not be
 * picked up until the next restart.
 */
async function mutate(
  res: Response,
  apply: () => void,
  onSuccess: () => void,
  reschedule = false,
): Promise<void> {
  try {
    apply();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Request failed';
    fail(res, message.startsWith('Unknown') ? 404 : 409, message);
    return;
  }

  if (reschedule) rescheduleClassUpdates();
  await triggerUpdate();
  onSuccess();
}

/* -------------------------------------------------------------------------- */
/* Student self-service                                                       */
/* -------------------------------------------------------------------------- */

/** A request that carried a valid student link token. */
interface StudentRequest extends Request {
  claims?: StudentTokenClaims;
}

/**
 * Auth for `/api/me`. The bearer here is a scoped link token from `/horaire`,
 * not `WEB_SECRET` — it names exactly one student and expires. The admin secret
 * is deliberately *not* accepted: these routes answer "who am I", and an admin
 * has no single identity.
 */
const checkStudentAuth: RequestHandler = (req, res, next) => {
  const header = req.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    fail(res, 401, 'Missing link token');
    return;
  }

  const claims = verifyStudentToken(webSecret, token);
  if (!claims) {
    fail(res, 401, 'Ce lien est invalide ou expiré. Refais /horaire sur Discord.');
    return;
  }

  (req as StudentRequest).claims = claims;
  next();
};

/** Resolve the token's claims against current data. */
function resolveClaims(
  claims: StudentTokenClaims,
): { school: School; student: Student } | null {
  const school = findSchool(claims.school);
  const student = school?.students.find((s) => s.name === claims.student);
  return school && student ? { school, student } : null;
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

export function createApp(): express.Express {
  const app = express();

  // TODO: restrict this to the panel's real origin once it has a fixed home.
  // The bearer token is the actual access control; CORS is not doing that job.
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));

  const api = express.Router();
  api.use(checkAuth);

  api.get('/status', (_req, res) => {
    res.json(getAllStatuses(new Date()));
  });

  api.get('/schools', (_req, res) => {
    res.json(getSchools());
  });

  api.post('/schools', (req, res, next) => {
    const parsed = parseSchool(req.body);
    if (typeof parsed === 'string') {
      fail(res, 400, parsed);
      return;
    }
    void mutate(
      res,
      () => addSchool(parsed),
      () => {
        res.status(201).json(parsed);
      },
      true,
    ).catch(next);
  });

  api.delete('/schools/:schoolName', (req, res, next) => {
    const { schoolName } = req.params;
    void mutate(
      res,
      () => removeSchool(schoolName),
      () => {
        res.json({ ok: true });
      },
      true,
    ).catch(next);
  });

  api.patch('/schools/:schoolName', (req, res, next) => {
    const parsed = parseSchoolPatch(req.body);
    if (typeof parsed === 'string') {
      fail(res, 400, parsed);
      return;
    }
    const { schoolName } = req.params;
    let updated: School | undefined;

    void mutate(
      res,
      () => {
        updated = updateSchool(schoolName, parsed);
      },
      () => {
        res.json(updated);
      },
    ).catch(next);
  });

  api.get('/schools/:schoolName/students', (req, res) => {
    const school = findSchool(req.params.schoolName);
    if (!school) {
      fail(res, 404, `Unknown school "${req.params.schoolName}"`);
      return;
    }
    res.json(school.students);
  });

  api.post('/schools/:schoolName/students', (req, res, next) => {
    const parsed = parseStudent(req.body);
    if (typeof parsed === 'string') {
      fail(res, 400, parsed);
      return;
    }
    const { schoolName } = req.params;
    void mutate(
      res,
      () => addStudent(schoolName, parsed),
      () => {
        res.status(201).json(parsed);
      },
      true,
    ).catch(next);
  });

  api.patch('/schools/:schoolName/students/:studentName', (req, res, next) => {
    const parsed = parseStudentPatch(req.body);
    if (typeof parsed === 'string') {
      fail(res, 400, parsed);
      return;
    }
    const { schoolName, studentName } = req.params;
    let updated: Student | undefined;

    void mutate(
      res,
      () => {
        updated = updateStudent(schoolName, studentName, parsed);
      },
      () => {
        res.json(updated);
      },
      true,
    ).catch(next);
  });

  api.delete('/schools/:schoolName/students/:studentName', (req, res, next) => {
    const { schoolName, studentName } = req.params;
    void mutate(
      res,
      () => removeStudent(schoolName, studentName),
      () => {
        res.json({ ok: true });
      },
      true,
    ).catch(next);
  });

  api.get('/overrides', (_req, res) => {
    res.json(getAllOverrides());
  });

  api.post('/overrides/:studentName', (req, res, next) => {
    if (typeof req.body !== 'object' || req.body === null) {
      fail(res, 400, 'Body must be an object');
      return;
    }
    const { studentName } = req.params;
    const patch = req.body as Partial<StudentOverride>;

    void mutate(res, () => setOverride(studentName, patch), () => {
      res.json({ ok: true });
    }).catch(next);
  });

  api.delete('/overrides/:studentName', (req, res, next) => {
    const { studentName } = req.params;
    void mutate(res, () => clearOverride(studentName), () => {
      res.json({ ok: true });
    }).catch(next);
  });

  api.post('/trigger-update', (_req, res, next) => {
    triggerUpdate()
      .then(() => {
        res.json({ ok: true });
      })
      .catch(next);
  });

  const me = express.Router();
  me.use(checkStudentAuth);

  me.get('/', (req, res) => {
    const claims = (req as StudentRequest).claims;
    const found = claims ? resolveClaims(claims) : null;
    if (!found) {
      fail(res, 404, "Ton profil n'existe plus. Contacte un administrateur.");
      return;
    }
    // Only what the page needs: no roster, no other schools, no discord ids.
    res.json({
      school: { name: found.school.name, colorHex: found.school.colorHex },
      student: {
        name: found.student.name,
        schedule: found.student.schedule,
        extraWeeks: found.student.extraWeeks ?? [],
        cycleStart: found.student.cycleStart ?? '',
        periods: found.student.periods ?? [],
        events: found.student.events ?? [],
      },
    });
  });

  me.patch('/schedule', (req, res, next) => {
    const claims = (req as StudentRequest).claims;
    const found = claims ? resolveClaims(claims) : null;
    if (!found) {
      fail(res, 404, "Ton profil n'existe plus. Contacte un administrateur.");
      return;
    }

    // Timetable fields only: a student cannot rename themselves, relink their
    // Discord account, or touch anybody else.
    const parsed = parseStudentPatch({
      schedule: req.body?.schedule,
      extraWeeks: req.body?.extraWeeks,
      cycleStart: req.body?.cycleStart,
      periods: req.body?.periods,
      events: req.body?.events,
    });
    if (typeof parsed === 'string') {
      fail(res, 400, parsed);
      return;
    }

    void mutate(
      res,
      () => updateStudent(found.school.name, found.student.name, parsed),
      () => {
        res.json({ ok: true });
      },
      true,
    ).catch(next);
  });

  // `/api/me` must come first: Express matches the `/api` prefix, and the admin
  // router's checkAuth would otherwise reject a student link token.
  app.use('/api/me', me);
  app.use('/api', api);

  // The student page is the same file in a different mode; the token in the
  // query string is what switches it.
  app.get('/moi', (_req, res) => {
    res.sendFile(PANEL_HTML);
  });

  app.use('/', express.static(PUBLIC_DIR));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[web] unhandled error:', err);
    if (!res.headersSent) fail(res, 500, 'Internal server error');
  });

  return app;
}

/** Load data, then start listening on `WEB_PORT`. */
export async function startWebServer(): Promise<Server> {
  dotenv.config();

  const secret = process.env.WEB_SECRET?.trim();
  if (!secret) throw new Error('WEB_SECRET is not set');
  webSecret = secret;

  const port = Number(process.env.WEB_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid WEB_PORT "${process.env.WEB_PORT}"`);
  }

  await ensureLoaded();

  const app = createApp();
  return new Promise<Server>((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`[web] panneau disponible sur http://localhost:${port}`);
      resolve(server);
    });
    server.once('error', reject);
  });
}
