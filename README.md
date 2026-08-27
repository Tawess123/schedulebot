# schedulebot

A Discord bot that answers one question for a small group of students: **who is free right now?**

Each student has a fixed weekly timetable (Monday–Friday). The bot reads that
timetable, applies whatever one-off changes apply to today — an absence, a
cancelled class, someone leaving at the break — and reports a traffic-light
status per student:

| | Meaning |
|---|---|
| 🔴 | In class |
| 🟡 | Between classes / partially available |
| 🟢 | Free |

A small web panel sits alongside the bot so the day's overrides can be edited
without typing Discord commands.

## Status

Feature-complete for a first run: persistence, status engine, Discord bot and
web panel are all in place. Not yet exercised against a live Discord server.

For server deployment, see [DEPLOY.md](DEPLOY.md).

## Requirements

- Node.js 20+ (developed on 24)
- A Discord application with a bot token, with the **Server Members** and
  **Message Content** privileged intents enabled

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
```

| Variable | Purpose |
|---|---|
| `DISCORD_TOKEN` | Bot token from the Discord developer portal |
| `CHANNEL_ID` | Channel the bot posts the schedule to |
| `PAUSE_ROLE_ID` | Role allowed to pause / resume the schedule |
| `WEB_PORT` | Port the web panel listens on |
| `WEB_SECRET` | Shared secret for the web panel API, and the signing key for `/horaire` links |
| `PUBLIC_URL` | Public address of the panel, used to build `/horaire` links (optional) |

## Scripts

| Command | Does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm start` | Run the compiled build |
| `npm run dev` | Run from source via ts-node |

## Layout

```
src/
  index.ts      entry point: starts the web panel, then the bot
  bot/
    discordBot.ts     client, embeds, buttons, cron scheduling
    statusEngine.ts   timetable + overrides -> StatusResult
  web/
    server.ts         Express API, bearer-authenticated under /api
    public/           the admin panel (single static HTML file)
  data/
    dataManager.ts    single source of truth for all persistent state
    schools.json      committed config: schools, students, weekly timetables
    overrides.json    generated at runtime, git-ignored, cleared daily
  shared/
    types.ts    interfaces shared by bot, web, and data
```

## Data model

`schools.json` is the config file you edit by hand or through the panel. A
school has a name, embed styling (`colorHex`, optional banner and thumbnail),
and a list of students. Each student has a name, an optional `discordId`, and a
schedule keyed `0`–`4` for Monday through Friday, where each day is a list of
`{ startTime, endTime, location }` slots.

`overrides.json` holds only today's exceptions, keyed by student name. It
carries the date it belongs to and is cleared automatically on the first access
of a new day, in the `America/Toronto` timezone.

All reads and writes go through `src/data/dataManager.ts`. State is held in
memory, so readers are synchronous; mutations flush to disk in the background.
