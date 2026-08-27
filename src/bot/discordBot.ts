import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  ModalSubmitInteraction,
  RepliableInteraction,
  StringSelectMenuInteraction,
  TextChannel,
} from 'discord.js';
import * as cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import * as dotenv from 'dotenv';

import {
  clearOverride,
  clearStatusMessageId,
  ensureLoaded,
  getOverride,
  getSchools,
  getStatusMessageIds,
  getStudentByDiscordId,
  setOverride,
  setStatusMessageId,
  updateStudent,
} from '../data/dataManager.js';
import {
  getAllStatuses,
  getCurrentClassIndex,
  getNextClassIndex,
  getTodaySlots,
} from './statusEngine.js';
import { describeSlot } from '../shared/types.js';
import type { School, StatusResult, Student } from '../shared/types.js';
import {
  DEFAULT_TOKEN_TTL_SECONDS,
  signStudentToken,
} from '../shared/studentToken.js';

/**
 * The Discord side of the bot: one status embed per school, kept current by a
 * cron tick at every class boundary, plus a row of buttons students use to
 * report changes to their own day.
 */

const TIMEZONE = 'America/Toronto';

/**
 * Button ids are static string literals, which is what makes the view survive a
 * restart: after reconnecting the client has no memory of the buttons it sent,
 * but the ids still route to the handlers registered below.
 */
const BTN_FINISH_CURRENT = 'btn_finish_curr';
const BTN_CANCEL_CURRENT = 'btn_cancel_curr';
const BTN_CANCEL_NEXT = 'btn_cancel_next';
const BTN_LEAVE_BREAK = 'btn_leave_break';
const BTN_STAY_SCHOOL = 'btn_stay_school';
const BTN_ABSENT_TODAY = 'btn_absent_today';
const BTN_SPOT = 'btn_spot';
const BTN_RESET = 'btn_reset';

const SELECT_SPOT = 'select_spot';
/** Sentinel option that swaps the dropdown for a free-text modal. */
const SPOT_OTHER = '__other__';
/** Sentinel option that clears a shared position. */
const SPOT_CLEAR = '__clear__';

const MODAL_SPOT = 'modal_spot';
const INPUT_SPOT = 'input_spot';

/** Discord caps a select menu at 25 options; two are ours. */
const MAX_PLACE_OPTIONS = 23;

const MODAL_LEAVE_BREAK = 'modal_leave_break';
const INPUT_DESTINATION = 'input_destination';

const MODAL_STAY_SCHOOL = 'modal_stay_school';
const INPUT_STAY_UNTIL = 'input_stay_until';

/** Discord caps an embed at 25 fields. */
const MAX_FIELDS = 25;
/** Discord caps a message at 10 embeds. */
const MAX_EMBEDS = 10;
/**
 * All schools live in one message now, so there is a single id to remember.
 * A school can never be called this, so it cannot collide with the old
 * per-school keys.
 */
const STATUS_MESSAGE_KEY = '__status__';
/**
 * Safety-net tick. Class boundaries have their own cron jobs, but a status can
 * also change at a time nothing scheduled — a "staying until 18:00" expiring,
 * the daily override reset at midnight. The tick recomputes every minute and
 * only touches Discord when the rendered statuses actually differ.
 */
const HEARTBEAT_MS = 60_000;
/** How long an ephemeral confirmation stays on screen. */
const CONFIRM_TTL_MS = 4_000;

const CMD_SCHEDULE = 'horaire';
const CMD_ADD_CLASS = 'cours';

interface BotConfig {
  token: string;
  channelId: string;
  pauseRoleId: string;
  /** Signs the personal timetable links handed out by `/horaire`. */
  webSecret: string;
  /** Where the panel is reachable from a browser. */
  publicUrl: string;
}

let config: BotConfig | null = null;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

const scheduledTasks: ScheduledTask[] = [];
let heartbeat: NodeJS.Timeout | null = null;
/** Rendered state of the last successful update, for the heartbeat to compare. */
let lastRenderSignature = '';

const HM_FORMATTER = new Intl.DateTimeFormat('fr-CA', {
  timeZone: TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function readConfig(): BotConfig {
  const token = process.env.DISCORD_TOKEN?.trim();
  const channelId = process.env.CHANNEL_ID?.trim();
  const pauseRoleId = process.env.PAUSE_ROLE_ID?.trim() ?? '';
  const webSecret = process.env.WEB_SECRET?.trim() ?? '';
  const port = process.env.WEB_PORT?.trim() || '3000';
  const publicUrl = (
    process.env.PUBLIC_URL?.trim() || `http://localhost:${port}`
  ).replace(/\/+$/, '');

  if (!token) throw new Error('DISCORD_TOKEN is not set');
  if (!channelId) throw new Error('CHANNEL_ID is not set');
  if (!pauseRoleId) {
    console.warn('[bot] PAUSE_ROLE_ID is not set — role syncing is disabled');
  }
  if (!webSecret) {
    console.warn('[bot] WEB_SECRET is not set — /horaire will be unavailable');
  }

  return { token, channelId, pauseRoleId, webSecret, publicUrl };
}

/**
 * Register `/horaire` on every guild the bot is in. Guild commands appear
 * immediately, unlike global ones which take up to an hour to propagate.
 */
async function registerCommands(): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName(CMD_SCHEDULE)
      .setDescription('Obtenir un lien personnel pour modifier ton horaire')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName(CMD_ADD_CLASS)
      .setDescription('Ajouter un cours de dernière minute à ton horaire')
      .setDMPermission(false)
      .addStringOption((option) =>
        option
          .setName('debut')
          .setDescription('Heure de début, ex. 13:00')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('fin')
          .setDescription('Heure de fin, ex. 15:00')
          .setRequired(true),
      )
      .addStringOption((option) =>
        option.setName('cours').setDescription('Nom du cours, ex. Calcul II'),
      )
      .addStringOption((option) =>
        option.setName('local').setDescription('Local, ex. B2431'),
      )
      .addStringOption((option) =>
        option
          .setName('date')
          .setDescription("aujourd'hui (défaut), demain, 2026-09-10 ou 10/09"),
      )
      .toJSON(),
  ];

  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.commands.set(commands);
    } catch (err: unknown) {
      console.error(`[bot] could not register /${CMD_SCHEDULE} on ${guild.name}:`, err);
    }
  }
  console.log(
    `[bot] /${CMD_SCHEDULE} et /${CMD_ADD_CLASS} enregistrées sur ${client.guilds.cache.size} serveur(s)`,
  );
}

/**
 * Resolve the `date:` option of /cours. Accepts `aujourd'hui`, `demain`,
 * `YYYY-MM-DD`, `JJ/MM` and `JJ-MM`; anything else is rejected rather than
 * guessed at. Empty means today.
 */
function resolveDateOption(raw: string, now: Date): string | null {
  const value = raw.trim().toLowerCase();
  const parts = torontoParts(now);
  const midnight = Date.UTC(parts.year, parts.month - 1, parts.day);
  const asKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  if (!value || value === "aujourd'hui" || value === 'aujourdhui' || value === 'auj') {
    return asKey(midnight);
  }
  if (value === 'demain') return asKey(midnight + 86_400_000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const short = /^(\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (short) {
    const day = Number(short[1]);
    const month = Number(short[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return `${parts.year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return null;
}

/** Today's date parts in the school timezone, for /cours date maths. */
function torontoParts(date: Date): { year: number; month: number; day: number } {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  const [year, month, day] = formatted.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/**
 * `/cours` — add a class that is not in the timetable, in one line, from a
 * phone, without opening the panel. Writes a dated event, the same thing the
 * panel's "Événements ponctuels" section manages.
 */
async function handleAddClassCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = getStudentByDiscordId(interaction.user.id);
  if (!found) {
    await interaction.editReply(
      "❌ Ton compte Discord n'est associé à aucun étudiant.",
    );
    return;
  }

  const startTime = normalizeTime(interaction.options.getString('debut', true));
  const endTime = normalizeTime(interaction.options.getString('fin', true));
  const course = (interaction.options.getString('cours') ?? '').trim();
  const room = (interaction.options.getString('local') ?? '').trim();
  const date = resolveDateOption(
    interaction.options.getString('date') ?? '',
    new Date(),
  );

  if (!startTime || !endTime) {
    await interaction.editReply('⏰ Heures invalides. Utilise le format `13:00`.');
    return;
  }
  if (endTime <= startTime) {
    await interaction.editReply('⏰ La fin doit être après le début.');
    return;
  }
  if (!date) {
    await interaction.editReply(
      '📅 Date invalide. Utilise `demain`, `2026-09-10` ou `10/09`.',
    );
    return;
  }
  // Either half identifies the class well enough; both is better.
  if (!course && !room) {
    await interaction.editReply(
      '📍 Indique au moins `cours:` ou `local:` (les deux fonctionnent aussi).',
    );
    return;
  }

  const event = { date, startTime, endTime };
  if (course) Object.assign(event, { course });
  if (room) Object.assign(event, { room });

  const events = [...(found.student.events ?? []), event].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  );

  try {
    updateStudent(found.school.name, found.student.name, { events });
  } catch (err: unknown) {
    await interaction.editReply(
      `⚠️ ${err instanceof Error ? err.message : 'Enregistrement impossible.'}`,
    );
    return;
  }

  // A new class means a new boundary the cron does not know about yet.
  rescheduleClassUpdates();
  await triggerUpdate();

  await interaction.editReply(
    `✅ Ajouté : **${describeSlot(event)}** le ${date} de ${startTime} à ${endTime}.\n` +
      'Retire-le depuis le panneau (`/horaire`) si besoin.',
  );
}

/** Hand the caller a private, expiring link to their own timetable. */
async function handleScheduleCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!config?.webSecret) {
    await interaction.editReply(
      "⚙️ Le panneau n'est pas configuré (WEB_SECRET manquant). Préviens un administrateur.",
    );
    return;
  }

  const found = getStudentByDiscordId(interaction.user.id);
  if (!found) {
    await interaction.editReply(
      "❌ Ton compte Discord n'est associé à aucun étudiant. " +
        'Demande à un administrateur de lier ton ID Discord dans le panneau.',
    );
    return;
  }

  const token = signStudentToken(config.webSecret, {
    student: found.student.name,
    school: found.school.name,
  });
  const url = `${config.publicUrl}/moi?t=${encodeURIComponent(token)}`;
  const days = Math.round(DEFAULT_TOKEN_TTL_SECONDS / 86400);

  await interaction.editReply(
    `🗓️ **Ton horaire — ${found.student.name} (${found.school.name})**\n` +
      `${url}\n\n` +
      `Ce lien est personnel et valide ${days} jours. Ne le partage pas : ` +
      'quiconque l\'a peut modifier ton horaire. Refais `/horaire` pour en obtenir un nouveau.',
  );
}

/* -------------------------------------------------------------------------- */
/* View                                                                       */
/* -------------------------------------------------------------------------- */

/** The persistent button row attached to the last school's status message. */
function buildMainView(): ActionRowBuilder<ButtonBuilder>[] {
  const first = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_FINISH_CURRENT)
      .setLabel('Cours terminé')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(BTN_CANCEL_CURRENT)
      .setLabel('Cours annulé')
      .setEmoji('🚫')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(BTN_CANCEL_NEXT)
      .setLabel('Annuler le prochain')
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Danger),
  );

  const second = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_LEAVE_BREAK)
      .setLabel('Parti à la pause')
      .setEmoji('🏃')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(BTN_STAY_SCHOOL)
      .setLabel("Je reste à l'école")
      .setEmoji('🏫')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(BTN_SPOT)
      .setLabel('Ma position')
      .setEmoji('📍')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(BTN_ABSENT_TODAY)
      .setLabel("Absent aujourd'hui")
      .setEmoji('🛌')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(BTN_RESET)
      .setLabel('Annuler mes changements')
      .setEmoji('↩️')
      .setStyle(ButtonStyle.Secondary),
  );

  return [first, second];
}

function buildLeaveBreakModal(): ModalBuilder {
  const destination = new TextInputBuilder()
    .setCustomId(INPUT_DESTINATION)
    .setLabel('Où vas-tu ?')
    .setPlaceholder('Maison, café, gym…')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);

  return new ModalBuilder()
    .setCustomId(MODAL_LEAVE_BREAK)
    .setTitle('Parti à la pause')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(destination),
    );
}

function buildStaySchoolModal(): ModalBuilder {
  const until = new TextInputBuilder()
    .setCustomId(INPUT_STAY_UNTIL)
    .setLabel("Tu restes jusqu'à quelle heure ?")
    .setPlaceholder('17:00')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(5);

  return new ModalBuilder()
    .setCustomId(MODAL_STAY_SCHOOL)
    .setTitle("Je reste à l'école")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(until),
    );
}

/**
 * The dropdown of places for one school, sent as an ephemeral reply so it can
 * be tailored to the caller. The status message is shared by every school, so
 * it could not carry a school-specific menu itself.
 */
function buildSpotMenu(
  school: School,
  current: string | undefined,
): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_SPOT)
    .setPlaceholder('Où es-tu en ce moment ?');

  for (const place of (school.places ?? []).slice(0, MAX_PLACE_OPTIONS)) {
    menu.addOptions({
      label: place.slice(0, 100),
      value: place.slice(0, 100),
      default: place === current,
    });
  }

  menu.addOptions({
    label: 'Autre… (écrire)',
    value: SPOT_OTHER,
    emoji: '✏️',
  });
  if (current) {
    menu.addOptions({
      label: 'Effacer ma position',
      value: SPOT_CLEAR,
      emoji: '🧹',
    });
  }

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildSpotModal(current: string | undefined): ModalBuilder {
  const input = new TextInputBuilder()
    .setCustomId(INPUT_SPOT)
    .setLabel('Où es-tu ?')
    .setPlaceholder('Cafétéria, local B2431, 3e étage…')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(80);
  if (current) input.setValue(current);

  return new ModalBuilder()
    .setCustomId(MODAL_SPOT)
    .setTitle('Ma position')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(input),
    );
}

/**
 * Accept `17:00`, `7:05` or `17h00` and return a canonical `HH:MM`, or null if
 * it is not a time at all. Students type this by hand, so be forgiving.
 */
function normalizeTime(raw: string): string | null {
  const match = /^(\d{1,2})\s*[:hH]\s*(\d{2})$/.exec(raw.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Embeds                                                                     */
/* -------------------------------------------------------------------------- */

function parseColor(colorHex: string): number {
  const value = Number.parseInt(colorHex.replace('#', ''), 16);
  return Number.isNaN(value) ? 0x5865f2 : value;
}

function buildEmbed(
  school: School,
  statuses: StatusResult[],
  now: Date,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    // Embed titles do not render markdown, so caps carry the emphasis here.
    .setTitle(school.name.toUpperCase())
    .setDescription(`Dernière mise à jour : ${HM_FORMATTER.format(now)}`)
    .setColor(parseColor(school.colorHex));

  // Every school shows its own banner. Stacking several makes a tall message,
  // which is the admin's call to make: use the thumbnail for a compact logo.
  if (school.bannerUrl) embed.setImage(school.bannerUrl);
  if (school.thumbnailUrl) embed.setThumbnail(school.thumbnailUrl);

  embed.addFields(
    statuses.slice(0, MAX_FIELDS).map((status) => ({
      name: `${status.emoji} ${status.name}`,
      value: status.nextEvent
        ? `${status.statusText}\n*${status.nextEvent}*`
        : status.statusText,
      inline: false,
    })),
  );

  return embed;
}

/* -------------------------------------------------------------------------- */
/* Update loop                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Updates are serialised. Buttons, chat messages and cron ticks all trigger
 * them, and two concurrent runs would each see "no message id yet" and post a
 * duplicate embed.
 */
let updateQueue: Promise<void> = Promise.resolve();

async function fetchStatusChannel(): Promise<TextChannel | null> {
  if (!config) return null;
  try {
    const channel = await client.channels.fetch(config.channelId);
    if (channel?.type !== ChannelType.GuildText) {
      console.error(`[bot] CHANNEL_ID ${config.channelId} is not a text channel`);
      return null;
    }
    return channel;
  } catch (err: unknown) {
    console.error('[bot] could not fetch the status channel:', err);
    return null;
  }
}

/** Everything the embeds show, flattened so two renders can be compared. */
function renderSignature(groups: ReturnType<typeof getAllStatuses>): string {
  return JSON.stringify(
    groups.map((group) => [
      group.school.name,
      group.school.colorHex,
      group.school.bannerUrl ?? '',
      group.school.thumbnailUrl ?? '',
      group.statuses.map((status) => [
        status.emoji,
        status.name,
        status.statusText,
        status.nextEvent ?? '',
      ]),
    ]),
  );
}

async function updateLoop(force: boolean): Promise<void> {
  const channel = await fetchStatusChannel();
  if (!channel) return;

  const now = new Date();
  const groups = getAllStatuses(now);

  const signature = renderSignature(groups);
  // The heartbeat stays quiet while nothing has moved; explicit triggers always
  // redraw, so a deleted message or a restart still gets repaired.
  if (!force && signature === lastRenderSignature) return;

  if (groups.length > MAX_EMBEDS) {
    console.warn(
      `[bot] ${groups.length} schools but Discord allows ${MAX_EMBEDS} embeds per message; extras are dropped`,
    );
  }

  const embeds = groups
    .slice(0, MAX_EMBEDS)
    .map((group) => buildEmbed(group.school, group.statuses, now));
  const payload = { embeds, components: buildMainView() };

  const existingId = getStatusMessageIds()[STATUS_MESSAGE_KEY];
  if (existingId) {
    try {
      const message = await channel.messages.fetch(existingId);
      await message.edit(payload);
      lastRenderSignature = signature;
      await updatePauseRoles(channel.guild, now);
      return;
    } catch {
      // Message was deleted out from under us — fall through and repost.
      clearStatusMessageId(STATUS_MESSAGE_KEY);
      lastRenderSignature = '';
    }
  }

  try {
    const sent = await channel.send(payload);
    setStatusMessageId(STATUS_MESSAGE_KEY, sent.id);
  } catch (err: unknown) {
    console.error('[bot] could not post the status message:', err);
    return;
  }

  lastRenderSignature = signature;
  await updatePauseRoles(channel.guild, now);
}

/**
 * Run {@link updateLoop}, queued behind any update already in flight.
 *
 * Called on every button press, modal submit, channel message, panel mutation
 * and class-boundary cron tick.
 */
export function triggerUpdate(force = true): Promise<void> {
  updateQueue = updateQueue
    .catch(() => undefined)
    .then(() => updateLoop(force))
    .catch((err: unknown) => {
      console.error('[bot] update failed:', err);
    });
  return updateQueue;
}

/** Start the once-a-minute safety net. Idempotent. */
function startHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => void triggerUpdate(false), HEARTBEAT_MS);
  // Must not keep the process alive on shutdown.
  heartbeat.unref();
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                      */
/* -------------------------------------------------------------------------- */

/** Give the pause role to every student who is currently free, take it from the rest. */
export async function updatePauseRoles(guild: Guild, now: Date): Promise<void> {
  if (!config?.pauseRoleId) return;

  const role = await guild.roles.fetch(config.pauseRoleId).catch(() => null);
  if (!role) {
    console.warn(`[bot] pause role ${config.pauseRoleId} not found in ${guild.name}`);
    return;
  }

  for (const { school, statuses } of getAllStatuses(now)) {
    const byName = new Map(statuses.map((status) => [status.name, status]));

    for (const student of school.students) {
      if (!student.discordId) continue;

      const status = byName.get(student.name);
      if (!status) continue;

      const member = await guild.members.fetch(student.discordId).catch(() => null);
      if (!member) continue;

      const shouldHaveRole = status.emoji === '🟢';
      const hasRole = member.roles.cache.has(role.id);

      try {
        if (shouldHaveRole && !hasRole) await member.roles.add(role);
        else if (!shouldHaveRole && hasRole) await member.roles.remove(role);
      } catch (err: unknown) {
        console.error(`[bot] could not sync the pause role for ${student.name}:`, err);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Scheduling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every distinct class boundary across all schools, as `HH:MM`. Covers every
 * week of a rotation and every dated event, since any of them can be the moment
 * a status changes.
 */
function collectClassTimes(): string[] {
  const times = new Set<string>();

  for (const school of getSchools()) {
    for (const student of school.students) {
      const weeks = [student.schedule, ...(student.extraWeeks ?? [])];

      for (const week of weeks) {
        for (const day of Object.values(week)) {
          for (const slot of day ?? []) {
            times.add(slot.startTime);
            times.add(slot.endTime);
          }
        }
      }

      for (const event of student.events ?? []) {
        times.add(event.startTime);
        times.add(event.endTime);
      }
    }
  }

  return [...times].sort();
}

/**
 * Arm one weekday cron job per class boundary. Safe to call again after the
 * timetables change — existing jobs are torn down first.
 */
export function rescheduleClassUpdates(): void {
  for (const task of scheduledTasks) {
    void task.destroy();
  }
  scheduledTasks.length = 0;

  for (const time of collectClassTimes()) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!match) {
      console.warn(`[bot] skipping unschedulable time "${time}"`);
      continue;
    }

    // Every day, not just weekdays: a dated event can land on a Saturday.
    const expression = `${Number(match[2])} ${Number(match[1])} * * *`;
    scheduledTasks.push(
      cron.schedule(expression, () => void triggerUpdate(), {
        timezone: TIMEZONE,
      }),
    );
  }

  console.log(`[bot] ${scheduledTasks.length} mises à jour planifiées`);
}

/* -------------------------------------------------------------------------- */
/* Interactions                                                               */
/* -------------------------------------------------------------------------- */

/** Answer an already-deferred interaction, then clean the reply up. */
async function confirm(
  interaction: RepliableInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({ content });
  setTimeout(() => {
    void interaction.deleteReply().catch(() => undefined);
  }, CONFIRM_TTL_MS);
}

/** Merge an index into one of the override's index lists, without duplicates. */
function withIndex(existing: number[] | undefined, index: number): number[] {
  return existing?.includes(index) ? existing : [...(existing ?? []), index];
}

function describeStudentSlot(
  student: Student,
  now: Date,
  index: number,
): string {
  const slot = getTodaySlots(student, now)[index];
  return slot
    ? `${describeSlot(slot)} (${slot.startTime}–${slot.endTime})`
    : 'ce cours';
}

async function handleButton(interaction: ButtonInteraction): Promise<void> {
  // A modal must be the first response, so it cannot follow a deferReply.
  if (interaction.customId === BTN_LEAVE_BREAK) {
    await interaction.showModal(buildLeaveBreakModal());
    return;
  }
  if (interaction.customId === BTN_STAY_SCHOOL) {
    await interaction.showModal(buildStaySchoolModal());
    return;
  }

  if (interaction.customId === BTN_SPOT) {
    const found = getStudentByDiscordId(interaction.user.id);
    if (!found) {
      await interaction.reply({
        content: "❌ Ton compte Discord n'est associé à aucun étudiant.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const current = getOverride(found.student.name).spot;
    // With no places configured there is nothing to pick from, so skip straight
    // to typing one.
    if (!found.school.places?.length) {
      await interaction.showModal(buildSpotModal(current));
      return;
    }

    await interaction.reply({
      content: '📍 Choisis un endroit :',
      components: [buildSpotMenu(found.school, current)],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = getStudentByDiscordId(interaction.user.id);
  if (!found) {
    await confirm(
      interaction,
      "❌ Ton compte Discord n'est associé à aucun étudiant.",
    );
    return;
  }

  const { student } = found;
  const now = new Date();
  const override = getOverride(student.name);
  let message: string;

  switch (interaction.customId) {
    case BTN_FINISH_CURRENT: {
      const index = getCurrentClassIndex(student, now);
      if (index === -1) {
        await confirm(interaction, "⏸️ Tu n'es dans aucun cours en ce moment.");
        return;
      }
      setOverride(student.name, {
        finishedClasses: withIndex(override.finishedClasses, index),
      });
      message = `✅ ${describeStudentSlot(student, now, index)} marqué comme terminé.`;
      break;
    }

    case BTN_CANCEL_CURRENT: {
      const index = getCurrentClassIndex(student, now);
      if (index === -1) {
        await confirm(interaction, "⏸️ Tu n'es dans aucun cours en ce moment.");
        return;
      }
      setOverride(student.name, {
        cancelledClasses: withIndex(override.cancelledClasses, index),
      });
      message = `🚫 ${describeStudentSlot(student, now, index)} marqué comme annulé.`;
      break;
    }

    case BTN_CANCEL_NEXT: {
      const index = getNextClassIndex(student, now);
      if (index === -1) {
        await confirm(interaction, "⏭️ Aucun cours à venir aujourd'hui.");
        return;
      }
      setOverride(student.name, {
        cancelledClasses: withIndex(override.cancelledClasses, index),
      });
      message = `🚫 ${describeStudentSlot(student, now, index)} marqué comme annulé.`;
      break;
    }

    case BTN_ABSENT_TODAY: {
      setOverride(student.name, { absentToday: true });
      message = "🛌 Marqué absent pour aujourd'hui.";
      break;
    }

    case BTN_RESET: {
      clearOverride(student.name);
      message = '♻️ Tes modifications du jour ont été effacées.';
      break;
    }

    default:
      await confirm(interaction, '❔ Bouton inconnu.');
      return;
  }

  await triggerUpdate();
  await confirm(interaction, message);
}

/** Apply a spot and refresh, shared by the dropdown and the free-text modal. */
async function applySpot(
  interaction: RepliableInteraction,
  studentName: string,
  spot: string,
): Promise<void> {
  setOverride(studentName, { spot });
  await triggerUpdate();
  await confirm(
    interaction,
    spot ? `📍 Position partagée : ${spot}.` : '🧹 Position effacée.',
  );
}

async function handleSpotSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const choice = interaction.values[0];
  const found = getStudentByDiscordId(interaction.user.id);

  if (choice === SPOT_OTHER) {
    const current = found ? getOverride(found.student.name).spot : undefined;
    await interaction.showModal(buildSpotModal(current));
    return;
  }

  await interaction.deferUpdate();
  if (!found) return;

  setOverride(found.student.name, { spot: choice === SPOT_CLEAR ? '' : choice ?? '' });
  await triggerUpdate();

  await interaction.editReply({
    content:
      choice === SPOT_CLEAR
        ? '🧹 Position effacée.'
        : `📍 Position partagée : ${choice}.`,
    components: [],
  });
  setTimeout(() => {
    void interaction.deleteReply().catch(() => undefined);
  }, CONFIRM_TTL_MS);
}

async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (
    interaction.customId !== MODAL_LEAVE_BREAK &&
    interaction.customId !== MODAL_STAY_SCHOOL &&
    interaction.customId !== MODAL_SPOT
  ) {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const found = getStudentByDiscordId(interaction.user.id);
  if (!found) {
    await confirm(
      interaction,
      "❌ Ton compte Discord n'est associé à aucun étudiant.",
    );
    return;
  }

  if (interaction.customId === MODAL_SPOT) {
    const spot = interaction.fields.getTextInputValue(INPUT_SPOT).trim();
    await applySpot(interaction, found.student.name, spot);
    return;
  }

  if (interaction.customId === MODAL_STAY_SCHOOL) {
    const raw = interaction.fields.getTextInputValue(INPUT_STAY_UNTIL);
    const until = normalizeTime(raw);
    if (!until) {
      await confirm(interaction, `⏰ « ${raw} » n'est pas une heure valide (ex. 17:00).`);
      return;
    }

    // Staying contradicts having left or being away all day.
    setOverride(found.student.name, {
      stayingUntil: until,
      leftAtBreak: false,
      absentToday: false,
    });

    await triggerUpdate();
    await confirm(interaction, `🏫 À l'école jusqu'à ${until}.`);
    return;
  }

  const destination = interaction.fields
    .getTextInputValue(INPUT_DESTINATION)
    .trim();

  setOverride(found.student.name, {
    leftAtBreak: true,
    destination: destination || undefined,
  });

  await triggerUpdate();
  await confirm(
    interaction,
    destination ? `🏃 Parti à la pause → ${destination}.` : '🏃 Parti à la pause.',
  );
}

/* -------------------------------------------------------------------------- */
/* Channel hygiene                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Delete the per-school status messages left over from the layout that used one
 * message per school. Runs once at startup and is a no-op afterwards.
 */
async function retireLegacyStatusMessages(): Promise<void> {
  const stored = getStatusMessageIds();
  const legacy = Object.keys(stored).filter((key) => key !== STATUS_MESSAGE_KEY);
  if (legacy.length === 0) return;

  const channel = await fetchStatusChannel();

  for (const key of legacy) {
    const id = stored[key];
    if (channel && id) {
      try {
        const message = await channel.messages.fetch(id);
        await message.delete();
      } catch {
        // Already gone; nothing to clean up.
      }
    }
    clearStatusMessageId(key);
  }

  console.log(`[bot] ${legacy.length} ancien(s) message(s) de statut retiré(s)`);
}

/**
 * Clear everything this bot did not post. The status channel is a dashboard,
 * not a conversation, so anything else in it is noise.
 */
async function purgeForeignMessages(): Promise<void> {
  const channel = await fetchStatusChannel();
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    for (const message of messages.values()) {
      if (message.author.id === client.user?.id) continue;
      await message.delete().catch(() => undefined);
    }
  } catch (err: unknown) {
    console.error('[bot] could not purge the status channel:', err);
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

client.once(Events.ClientReady, (readyClient) => {
  console.log(`[bot] connecté comme ${readyClient.user.tag}`);

  void (async () => {
    await registerCommands();
    await retireLegacyStatusMessages();
    await purgeForeignMessages();
    rescheduleClassUpdates();
    startHeartbeat();
    await triggerUpdate();
  })();
});

client.on(Events.InteractionCreate, (interaction) => {
  void (async () => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === CMD_SCHEDULE) {
          await handleScheduleCommand(interaction);
        } else if (interaction.commandName === CMD_ADD_CLASS) {
          await handleAddClassCommand(interaction);
        }
      } else if (interaction.isButton()) await handleButton(interaction);
      else if (interaction.isStringSelectMenu()) {
        if (interaction.customId === SELECT_SPOT) {
          await handleSpotSelect(interaction);
        }
      } else if (interaction.isModalSubmit()) await handleModal(interaction);
    } catch (err: unknown) {
      console.error('[bot] interaction failed:', err);
    }
  })();
});

client.on(Events.MessageCreate, (message) => {
  if (!config || message.channelId !== config.channelId) return;
  if (message.author.bot) return;

  void (async () => {
    await message.delete().catch(() => undefined);

    const found = getStudentByDiscordId(message.author.id);
    if (found) {
      // A message in the status channel is read as "here is why I'm on a break".
      setOverride(found.student.name, {
        pauseNote: message.content.trim(),
        leftAtBreak: false,
      });
    }

    await triggerUpdate();
  })();
});

client.on(Events.Error, (err) => {
  console.error('[bot] client error:', err);
});

/** Load configuration and data, then connect to Discord. */
export async function startBot(): Promise<Client> {
  dotenv.config();
  config = readConfig();

  await ensureLoaded();
  await client.login(config.token);

  return client;
}
