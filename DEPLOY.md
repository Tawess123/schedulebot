# Deploying schedulebot on Ubuntu Server

Tested target: Ubuntu Server 22.04 / 24.04 LTS. The bot and the web panel run in
a single container; all persistent state is JSON on a bind mount.

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
3. Invite the bot with the scopes `bot` plus these permissions: *View Channel*,
   *Send Messages*, *Manage Messages*, *Read Message History*, *Manage Roles*.
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
WEB_PORT=3000
WEB_SECRET=a-long-random-string
PUBLIC_URL=https://panel.example.com
```

`PUBLIC_URL` is the address students will open from Discord. Leave it blank
during local testing (it falls back to `http://localhost:WEB_PORT`); set it to
the real domain once Nginx is in front (section 7), or the `/horaire` links will
point at the server's own localhost and fail for everyone else.

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
    "bannerUrl": "https://…",      // optional
    "thumbnailUrl": "https://…",   // optional
    "students": [
      {
        "name": "Alexandre",
        "discordId": "",           // fill in later via the panel
        "schedule": {
          "0": [                    // 0 = Monday … 4 = Friday
            { "startTime": "08:30", "endTime": "11:20", "location": "B2431" }
          ],
          "1": [], "2": [], "3": [], "4": []
        }
      }
    ]
  }
]
```

All five weekday keys must be present; a free day is `[]`. Times are 24-hour
`HH:MM` and are interpreted in **America/Toronto**, which is hard-coded.

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
curl -s -H "Authorization: Bearer $WEB_SECRET" http://localhost:3000/api/status
```

The bot posts one embed per school in `CHANNEL_ID` and attaches the button row
to the last one.

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
[web] panneau disponible sur http://localhost:3000
[bot] connecté comme schedulebot#1234
[bot] 9 mises à jour planifiées
```

Common failures:

| Log line | Cause |
|---|---|
| `Error: DISCORD_TOKEN is not set` | `.env` missing or the key is empty |
| `DiscordjsError [TokenInvalid]` | Wrong or regenerated bot token |
| `Used disallowed intents` | Privileged intents not enabled (section 1) |
| `CHANNEL_ID … is not a text channel` | Wrong ID, or the bot cannot see the channel |
| `pause role … not found` | Wrong `PAUSE_ROLE_ID`, or the bot's role sits too low |

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

## 7. Optional: Nginx reverse proxy with HTTPS

By default Compose publishes the panel on every interface, so
`http://your-server:3000` is reachable from the open internet with no TLS. When
you put Nginx in front, bind the container to loopback instead — edit
`docker-compose.yml`:

```yaml
    ports:
      - '127.0.0.1:${WEB_PORT:-3000}:${WEB_PORT:-3000}'
```

Then `docker compose up -d` to apply.

Install Nginx and Certbot:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/schedulebot`:

```nginx
server {
    listen 80;
    server_name panel.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
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

sudo certbot --nginx -d panel.example.com
```

Certbot rewrites the server block for TLS and installs a renewal timer. Confirm
renewal works:

```bash
sudo certbot renew --dry-run
```

Firewall, if `ufw` is active:

```bash
sudo ufw allow 'Nginx Full'
sudo ufw delete allow 3000/tcp   # if you had opened it directly
```

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

1. Open the panel (`https://panel.example.com`, or `http://server-ip:3000`).
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
time and room. Empty days are fine.
