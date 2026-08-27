# Deploying schedulebot on Ubuntu Server

Tested target: Ubuntu Server 22.04 / 24.04 LTS. The bot and the web panel run in
a single container; all persistent state is JSON on a bind mount.

This guide is written for the intended setup: the panel on port **3751**,
reachable at **https://bot.tawess123.ca**.

> **This will not run on cPanel shared hosting.** cPanel's "Setup Node.js App"
> runs behind Phusion Passenger, which starts a process when an HTTP request
> arrives and stops it when traffic goes quiet. This app is the opposite shape:
> it holds a permanent WebSocket to Discord's gateway and fires cron jobs at
> class boundaries, whether or not anyone opens the panel. Passenger would keep
> killing the gateway connection, and many shared hosts also cap long-lived
> outbound sockets and background processes. Use the VPS.

---

## 1. Prerequisites

Install Docker Engine, the Compose plugin, and Git.

```bash
sudo apt update
sudo apt install -y git ca-certificates curl
```

Ubuntu's own `docker.io` package ships an older Docker without the `docker
compose` v2 plugin, so use Docker's repository instead:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
```

Let your user run Docker without `sudo` (log out and back in afterwards):

```bash
sudo usermod -aG docker "$USER"
```

Verify:

```bash
docker --version
docker compose version
git --version
```

### Discord application setup

Before deploying, at <https://discord.com/developers/applications>:

1. Create an application, then a bot, and copy its **token**.
2. Under **Bot → Privileged Gateway Intents**, enable **Server Members Intent**
   and **Message Content Intent**. The bot uses both; without them it will fail
   to log in.
3. Invite the bot with **both** scopes `bot` **and** `applications.commands` —
   the second is what lets `/horaire` and `/cours` register. Grant these
   permissions: *View Channel*, *Send Messages*, *Manage Messages*,
   *Read Message History*, *Manage Roles*.
4. In **Server Settings → Roles**, drag the bot's own role **above** the pause
   role. Discord will not let a bot assign a role that sits higher than its own.

> **The status channel is wiped.** On startup and on every incoming message, the
> bot deletes anything in `CHANNEL_ID` that it did not post itself. Point it at a
> dedicated channel, never a conversation channel.

---

## 2. Clone the repo and create `.env`

```bash
cd /opt
sudo git clone <your-repo-url> schedulebot
sudo chown -R "$USER:$USER" schedulebot
cd schedulebot

cp .env.example .env
```

Edit `.env`:

```ini
DISCORD_TOKEN=your-bot-token
CHANNEL_ID=123456789012345678
PAUSE_ROLE_ID=123456789012345678
WEB_PORT=3751
WEB_SECRET=a-long-random-string
PUBLIC_URL=https://bot.tawess123.ca
```

`WEB_PORT=3751` is picked to sit clear of anything else on the VPS. Compose
reads it straight from this file, so nothing else needs editing.

`PUBLIC_URL` is the address students will open from Discord. It must be the
public domain, not localhost, or the `/horaire` links will point at the server's
own loopback and fail for everyone else. Set it before the first start.

Generate a strong secret — it is the **only** thing protecting the admin API:

```bash
openssl rand -hex 32
```

`.env` is git-ignored. Keep it out of the repo and back it up separately.

> `docker compose` reads `.env` both for `env_file` and to interpolate
> `WEB_PORT` into the published port. The file must exist before you run any
> compose command, or you get
> `env file /opt/schedulebot/.env not found`.

---

## 3. Populate `src/data/schools.json`

Schools, students and weekly timetables live in `src/data/schools.json`, which
is committed to the repo. Start from the full example — three schools
(Montmorency, Bois-de-Boulogne, Dawson) with their timetables already filled in:

```bash
cp src/data/schools.json.example src/data/schools.json
```

Every `discordId` in the example is an empty string; fill them in through the
web panel once the stack is up (section 8).

The shape is:

```jsonc
[
  {
    "name": "Montmorency",
    "colorHex": "#005EB8",
    "bannerUrl": "https://…",      // optional, big image at the bottom
    "thumbnailUrl": "https://…",   // optional, small logo top-right
    "places": ["Cafétéria", "Bibliothèque"],   // optional, for 📍 Ma position
    "students": [
      {
        "name": "Alexandre",
        "discordId": "",           // fill in later via the panel
        "schedule": {
          "0": [                    // 0 = Monday … 4 = Friday
            {
              "startTime": "08:30",
              "endTime": "11:20",
              "course": "Calcul II",  // either one is enough,
              "room": "B2431"         // both together is better
            }
          ],
          "1": [], "2": [], "3": [], "4": []
        },

        // Everything below is optional.
        "periods": [                // a different week between two dates
          {
            "from": "2026-09-01",
            "to": "2026-09-14",
            "label": "Rentrée",
            "schedule": { "0": [], "1": [], "2": [], "3": [], "4": [] }
          }
        ],
        "events": [                 // one-off classes on a given date
          {
            "date": "2026-09-10",
            "startTime": "13:00",
            "endTime": "16:00",
            "course": "Examen final"
          }
        ]
      }
    ]
  }
]
```

All five weekday keys must be present; a free day is `[]`. Times are 24-hour
`HH:MM` and are interpreted in **America/Toronto**, which is hard-coded.

A class needs a `course`, a `room`, or both — never neither. Older timetables
using a single `location` field still work; the panel splits it into the right
field the next time you edit that class.

**Images must be png, jpg, gif or webp.** Discord's embed proxy does not render
SVG, so the API refuses an `.svg` URL rather than leaving a blank space in the
channel.

`src/data/` is bind-mounted into the container, so this file and the
runtime-generated `overrides.json` survive rebuilds. Because the mount *shadows*
the image's copy, `schools.json` must exist on the host before the first start —
cloning the repo satisfies that.

---

## 4. Start the stack

```bash
docker compose up -d --build
```

Check that it came up:

```bash
docker compose ps
curl -s -H "Authorization: Bearer $WEB_SECRET" http://localhost:3751/api/status
```

The bot posts **one message** in `CHANNEL_ID` carrying one embed per school,
with a single row of buttons under it. On the first start after an upgrade it
also deletes the older per-school messages it used to post.

> **A bad `DISCORD_TOKEN` crash-loops the container.** The process exits when
> the Discord login fails, and `restart: unless-stopped` starts it again. If
> `docker compose ps` shows the service restarting, check the logs first.

---

## 5. Viewing logs

```bash
docker compose logs -f schedulebot
```

Useful variants:

```bash
docker compose logs --tail=100 schedulebot     # recent history only
docker compose logs --since=10m schedulebot    # last ten minutes
```

What healthy startup looks like:

```
[web] panneau disponible sur http://localhost:3751
[bot] connecté comme schedulebot#1234
[bot] /horaire et /cours enregistrées sur 1 serveur(s)
[bot] 34 mises à jour planifiées
```

The last number is one cron job per distinct class boundary across every
timetable, rotation week and dated event — it grows with your data. A 60-second
heartbeat also re-checks the statuses and only edits Discord when something
actually changed.

Common failures:

| Log line | Cause |
|---|---|
| `Error: DISCORD_TOKEN is not set` | `.env` missing or the key is empty |
| `DiscordjsError [TokenInvalid]` | Wrong or regenerated bot token |
| `Used disallowed intents` | Privileged intents not enabled (section 1) |
| `CHANNEL_ID … is not a text channel` | Wrong ID, or the bot cannot see the channel |
| `pause role … not found` | Wrong `PAUSE_ROLE_ID`, or the bot's role sits too low |
| `could not register /horaire` | Bot invited without the `applications.commands` scope |
| `WEB_SECRET is not set` | `.env` missing the secret — the web server refuses to start |

---

## 6. Updating

```bash
cd /opt/schedulebot
git pull
docker compose up -d --build
```

`src/data/` is a bind mount, so `schools.json` and `overrides.json` are
untouched by a rebuild.

One caveat: `schools.json` is **tracked by git**. If you edited it on the server
and the incoming commit also changes it, `git pull` will refuse to merge. Either
commit your server-side edits, or stash them:

```bash
git stash && git pull && git stash pop
```

To roll back, check out the previous commit and rebuild:

```bash
git log --oneline -5
git checkout <previous-sha>
docker compose up -d --build
```

---

## 7. Nginx reverse proxy with HTTPS

Not optional here: `PUBLIC_URL` is an `https://` address, and the `/horaire`
links students receive point at it.

**Point the DNS first.** Add an `A` record for `bot.tawess123.ca` to the VPS's
public IP and wait for it to resolve — Certbot validates over HTTP and will fail
otherwise:

```bash
dig +short bot.tawess123.ca
```

By default Compose publishes the panel on every interface, so
`http://your-server:3751` would be reachable from the open internet with no TLS.
Bind it to loopback instead — edit `docker-compose.yml`:

```yaml
    ports:
      - '127.0.0.1:${WEB_PORT:-3000}:${WEB_PORT:-3000}'
```

The `:-3000` is only Compose's fallback when `WEB_PORT` is unset; your `.env`
sets 3751, so that is what gets published. Then `docker compose up -d` to apply.

Install Nginx and Certbot:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/schedulebot`:

```nginx
server {
    listen 80;
    server_name bot.tawess123.ca;

    location / {
        proxy_pass         http://127.0.0.1:3751;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Enable it and obtain a certificate:

```bash
sudo ln -s /etc/nginx/sites-available/schedulebot /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

sudo certbot --nginx -d bot.tawess123.ca
```

Certbot rewrites the server block for TLS and installs a renewal timer. Confirm
renewal works:

```bash
sudo certbot renew --dry-run
```

Firewall, if `ufw` is active:

```bash
sudo ufw allow 'Nginx Full'
sudo ufw delete allow 3751/tcp   # if you had opened it directly
```

Port 3751 never needs to be open to the internet: after the loopback change,
only Nginx reaches it.

Two things to know about the panel's security model:

- The bearer token is the only access control. The static page at `/` is served
  without authentication (a browser cannot attach an `Authorization` header to
  its own page load); everything under `/api` requires the token.
- CORS is currently wide open (`app.use(cors())` in `src/web/server.ts`, marked
  with a TODO). Any web page can call the API from a browser — it still needs
  the token, but tighten `origin` once the panel has a fixed home.

---

## 8. Finding Discord IDs and linking students

Discord IDs are hidden until you turn on Developer Mode.

**Enable Developer Mode:** User Settings (gear, bottom-left) → **Advanced** →
toggle **Developer Mode**.

Then right-click to copy each ID:

| You need | Where to right-click | Menu item |
|---|---|---|
| `CHANNEL_ID` | The status channel in the sidebar | Copy Channel ID |
| `PAUSE_ROLE_ID` | Server Settings → Roles → the role | Copy Role ID |
| A student's `discordId` | The member, in the member list or on a message | Copy User ID |

On mobile, long-press instead of right-clicking.

IDs are 17–19 digit numbers. Keep them as **strings** in JSON — they exceed
JavaScript's safe integer range, so unquoting one silently corrupts it.

### Linking a student through the web panel

1. Open the panel at `https://bot.tawess123.ca` (or `http://server-ip:3751`
   before Nginx is in front).
2. In **Réglages**, paste your `WEB_SECRET` into *Mot de passe principal* and press
   **Enregistrer**. It is kept in that browser's `localStorage`; the connection
   dot in the header turns green once the token is accepted.
3. Open **Écoles et étudiants** and expand the student's school.
4. Click the **ID Discord** field on their row, paste the copied ID, and press
   Enter (or click away). It saves immediately and the bot's embeds redraw.

Students without a `discordId` still appear in the status embeds — they just
cannot press the buttons, they never receive the pause role, and `/horaire`
will refuse them.

### Letting students edit their own timetable

Once a student's `discordId` is set, they can run **`/horaire`** in the server.
The bot replies privately with a personal link to `PUBLIC_URL/moi?t=…` that
opens a page containing only their own timetable — weeks, class slots and
one-off events — with no access to other students, the roster, or the overrides.

The link carries a token signed with `WEB_SECRET`, scoped to that one student,
and valid for seven days. It is not the admin password: it cannot read or change
anything else, and the API refuses it on every `/api` route outside `/api/me`.

Two consequences worth knowing:

- **Anyone holding the link can edit that student's timetable.** It is a bearer
  link, like a password-reset URL. Students should not paste it in a channel.
  Running `/horaire` again simply issues a fresh one.
- **Changing `WEB_SECRET` invalidates every outstanding link**, since the secret
  is the signing key. Students just re-run `/horaire`.

To add someone new, use **Ajouter un étudiant** in the same panel: enter a name,
optionally the Discord ID, then add class slots per weekday with start time, end
time, and a course name and/or a room. Empty days are fine.

---

## 9. What students can do once they are linked

Everything below needs their `discordId` filled in (section 8).

### Buttons under the status message

| Button | Effect |
|---|---|
| ✅ Cours terminé | Marks the current class as over — they read as free |
| 🚫 Cours annulé | Marks the current class cancelled |
| ⏭️ Annuler le prochain | Same, for the next class of the day |
| 🏃 Parti à la pause | Left the building, with an optional destination |
| 🏫 Je reste à l'école | Stays available past the timetable, until a given time |
| 📍 Ma position | Shares where they are, from the school's `places` list or free text |
| 🛌 Absent aujourd'hui | Away all day |
| ↩️ Annuler mes changements | Wipes everything they declared today |

A position only shows while the student is free — in class, the timetable
already says where they are. All of it resets on its own at midnight,
America/Toronto.

Fill each school's **Lieux de rencontre** in the panel (comma separated:
`Cafétéria, Bibliothèque, Agora`) so the 📍 button offers a dropdown instead of
asking them to type.

### Slash commands

```
/horaire                                        personal link to their timetable
/cours debut:13:00 fin:15:00 local:B2431        add a last-minute class
/cours debut:9h30 fin:11:00 cours:Examen date:demain
```

`/cours` takes `cours:` and/or `local:` — either one is enough. `date:` accepts
`aujourd'hui` (the default), `demain`, `2026-09-10` or `10/09`, and times accept
`13:00` as well as `13h00`. The class is added immediately and the bot re-arms
its schedule so the new time triggers an update.

### Writing in the status channel

Anything a linked student types in `CHANNEL_ID` is deleted and becomes their
pause note for the day. Anyone else's message is simply deleted.
