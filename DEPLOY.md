# Deploying Presentail Hive on Railway

The repo is ready for Railway: `railway.json` sets the build (`npm run build`), start (`npm start`) and health check (`/healthz`), and `.nvmrc` / `engines` pin Node 22. The app stores its SQLite database on a Railway volume automatically.

Budget about 10 minutes.

## 1. Create the service

1. Go to [railway.com](https://railway.com) and sign in with GitHub.
2. **New Project → Deploy from GitHub repo** and pick the Hive repository. Allow Railway's GitHub app access to it if it asks.
3. In the service's **Settings → Source**, check that the branch is `main`.

The first deploy fails with *"Refusing to start: set APP_PASSWORD"*. That's expected. Continue to step 2.

## 2. Attach a volume (keeps your data)

Service → right-click (or **⋯**) → **Attach Volume** → mount path `/data`.

Without a volume, every deploy wipes all agents, tasks and chats. The app detects the volume through `RAILWAY_VOLUME_MOUNT_PATH` and stores `hive.db` there, so no extra variable is needed.

## 3. Set variables

Service → **Variables** → add:

| Variable | Value |
|---|---|
| `APP_PASSWORD` | A long password. The browser asks for it; the username can be anything. |
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com. Lets the Claude agents reply. |
| `PUBLIC_URL` | `https://hive.presentail.com` |
| `TZ` | `Asia/Dubai` (optional; only affects server log timestamps) |

Saving the variables triggers a redeploy. When it's green, open the temporary `*.up.railway.app` URL (Settings → Networking → **Generate Domain**) to check it works.

## 4. Connect hive.presentail.com

1. Service → **Settings → Networking → Custom Domain** → enter `hive.presentail.com`.
2. Railway shows a **CNAME target** (something like `abc123.up.railway.app`) and sometimes a TXT verification record.
3. Where presentail.com's DNS is managed, add:
   - `CNAME`  name `hive`  →  the target Railway showed
   - the `TXT` record too, if Railway asked for one
   - On Cloudflare, set the CNAME to **DNS only** (grey cloud) until Railway shows the domain as verified.
4. Wait for Railway to show a green check. HTTPS is issued automatically, usually within minutes.

## 5. First login

Open https://hive.presentail.com and sign in with `APP_PASSWORD`. Production starts with **template** agents and workflows based on the Presentail month-end routines. All workflows are **switched off** until you've reviewed them. Edit, delete or enable them from the Workflows page.

## Updating

Every push to `main` redeploys automatically. The database on the volume is kept.

## Backups

Railway volumes support backups (Volume → **Backups**). Turn on a daily schedule.

## Continue with Google (sign-in)

Hive signs people in with Google and only lets in `@presentail.com` accounts. Until Google is configured, it falls back to `APP_PASSWORD`.

### A. Create the Google sign-in credentials (about 5 minutes)

1. Open [console.cloud.google.com](https://console.cloud.google.com) signed in as your presentail.com admin account. Create a project named **Presentail Hive**, or pick an existing one.
2. **APIs & Services → OAuth consent screen** (called **Google Auth Platform → Branding / Audience** in newer consoles):
   - App name `Presentail Hive`, support email: yours.
   - Audience / User type: **Internal**. Only presentail.com Workspace accounts can then sign in, and no Google review is needed.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** (or **Clients → Create client**):
   - Application type: **Web application**, name `Hive`.
   - **Authorized JavaScript origins**: `https://hive.presentail.com`
   - **Authorized redirect URIs**: `https://hive.presentail.com/auth/google/callback`
   - Create, then copy the **Client ID** and **Client secret**.

### B. Add them in Railway → service → Variables

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | the Client ID (ends in `.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | the Client secret |
| `SESSION_SECRET` | any long random string, e.g. 40+ random characters. It keeps people signed in across deploys. |
| `ALLOWED_EMAIL_DOMAIN` | optional, default `presentail.com` (comma-separate several) |
| `ALLOWED_EMAILS` | optional: specific outside addresses to let in, e.g. `accountant@gmail.com` |

Deploy, then open https://hive.presentail.com. You'll see **Continue with Google**. Once that works, you can delete `APP_PASSWORD`.

Sessions last 30 days. **Sign out** is at the bottom of the sidebar.

## Agents that do real work (Claude Managed Agents)

Agents set to **Claude Managed Agent** run on Anthropic's hosted agent service. Each one gets a private sandbox, your skills from `agent-skills/`, and access only to the systems you tick.

### Railway variables

| Variable | Why |
|---|---|
| `ANTHROPIC_API_KEY` | Required. A key from console.anthropic.com in a workspace with access to Managed Agents. |
| `WAFEQ_API_KEY` | Lets agents with the **Wafeq** integration post to Wafeq. It's stored in an Anthropic vault and is never visible to the agent: the sandbox only sees a placeholder, swapped for the real key on requests to `api.wafeq.com`. |

### Turning an agent on
1. Open the agent → **Skills & tools**.
2. Tick its skills (e.g. Talabat, Careem, Noon Food, Now Now month-end for the UAE Accountant) and systems (Wafeq).
3. Choose **Approvals**: *Ask before posting* (it does a dry run and waits for your go-ahead) or *Ask before every command*.
4. Click **Make it a Managed Agent** / **Save & sync**.

### Running a task
Create a task for the agent, attach the source files (statement PDFs, spreadsheets) and click **Create & start**. The task window shows the live run: files, what the agent is doing, approval requests (**Approve / Reject**), its answers, a reply box, and the cost so far. When the agent finishes a turn, the task moves to **Needs review** with its summary as the result.

### Adding or changing skills
Skills are folders in `agent-skills/<name>/` with a `SKILL.md` (plus `scripts/` and `references/`). Commit a change and redeploy. The next time an agent using that skill is synced, Hive uploads the new version automatically.
