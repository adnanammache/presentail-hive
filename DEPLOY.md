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
| `WAFEQ_API_KEY` | Lets agents with the **Wafeq** integration post to Wafeq. It stays in Hive and never reaches the agent's sandbox: agents call Wafeq through Hive's gateway. Reads (checking what's already booked) run immediately; every write (bills, invoices, payments, attachments) is queued, and the agent submits the whole batch for one approval. Hive then posts it in order. Set `PUBLIC_URL` so the sandbox can reach the gateway. |

### Turning an agent on
1. Open the agent → **Skills & tools**.
2. Tick its skills (e.g. Talabat, Careem, Noon Food, Now Now month-end for the UAE Accountant) and systems (Wafeq).
3. Choose **Approvals**: *Ask before posting* (it does a dry run and waits for your go-ahead), *Ask before every command*, or *Never ask* (it posts to Odoo and Wafeq on its own; every call is still logged).
4. Click **Make it a Managed Agent** / **Save & sync**.

### Running a task
Click **New task** (bottom-right composer), assign the agent, attach the source files (statement PDFs, spreadsheets) and click **Create & start**. **Save task** saves it without starting; start it later from the task. The task panel shows the live run: what the agent is doing, approval requests (**Approve / Reject**), its answers, a reply box, and the cost so far. When the agent finishes a turn, the task moves to **Needs review** with its summary as the result.

## Tasks, people and projects

Work is shared by people and AI agents: **My tasks**, **All tasks** and **Projects** show the same tasks.

- **One accountable assignee**: a person (anyone who has signed in) or an AI agent, or nobody. Assigning a person notifies them (their Inbox and their phone, if they turned notifications on). Assigning an agent does **not** start it: starting is always an explicit **Create & start** / **Start** click, and a retry never starts a second run.
- **Stages**: Backlog → Ready → In progress → Needs review → Done. Moving a card never starts, stops or runs anything.
- **Blocked is separate from the stage**: *waiting for information*, *waiting for approval* or *execution failed*, with a reason and who needs to act. A failed start or run keeps the task where it was, marked *Execution failed*, with a **Retry**.
- **Review ownership**: "awaiting your review" counts a task in Needs review only for its reviewer, or the person who created it if no reviewer is set. Tasks from before this change (no creator recorded) go to workspace owners. Agent command approvals count for approvers.
- **Projects** are optional. Anyone signed in can see every project; its owner (or a workspace owner) edits, archives, deletes and manages members; members add tasks and reference files. Adding an agent to a project gives it no new system access and doesn't start it. Archiving keeps the tasks and their history; deleting a project keeps its tasks (without a project). Health ("On track") is only shown when the owner sets it.
- **Drafts**: the composer saves your draft on the server as you type (only you see it); it's never a task until you submit.

## People, teams and invitations

- **Your profile**: click your name at the bottom left → **My profile**: photo (upload and crop, remove, or use your Google photo), display name, job title, about and timezone. Your email comes from Google and can't be changed. Nobody edits someone else's profile.
- **Photos**: an uploaded photo wins; otherwise your Google photo; otherwise initials. Removing your photo keeps initials; signing in again never brings the Google photo back or replaces an upload. The same picture shows in the sidebar, Team & agents, pickers, tasks, comments, activity and projects.
- **Teams hold people and AI agents.** People can be on several teams; an agent keeps its one team (moving it is an owner action, as before). A **team lead** can add and remove people on their own team, and nothing else: no workspace permissions, no roles, no invitations. Job titles grant nothing. Joining a team never starts an agent, assigns work or grants system or project access.
- **Workspace roles** stay Owner / Approver / Member (Settings → People). Owners manage teams, leads, managers, roles, invitations and access. Hive always keeps at least one owner.
- **Invitations** (owners): Team & agents → **Invite people**. The person joins when they sign in with Google using the invited email (outside addresses work only when invited). Links expire after 7 days; **Resend** makes a new link, **Revoke** cancels. Pending invitations aren't members and can't be given tasks.
- **Turning off access** (Settings → People) keeps everyone's tasks, comments and history; the person can't sign in or be given new work, and Hive lists their open tasks to reassign.

### Railway variables for invitation emails (optional)
| Variable | What it does |
|---|---|
| `RESEND_API_KEY` | Sends invitation emails through [Resend](https://resend.com). Without it, Hive doesn't claim to send anything: it gives you the invitation link to share yourself. |
| `MAIL_FROM` | The sender, e.g. `Presentail Hive <hive@presentail.com>` (the domain must be verified in Resend). |

### What the update migrates (automatically, once)
- Stage "To do" becomes **Ready**.
- "Blocked" tasks keep their reason as a blocker (*execution failed* if it said it couldn't start or run, otherwise *waiting for information*). Their stage becomes **In progress** if the task ever had a run, else **Ready**: the earlier stage wasn't recorded, so nothing else is guessed.
- Task ids, descriptions, assignments, due dates, files and run history are unchanged. Tasks created before this have no recorded creator.
- The Agent API keeps its original words for existing automations: a Ready task is reported as `todo`, a blocked one as `blocked` (with `stage` and `blocker` alongside). Agents can still set `blocked` (kept as *waiting for information*), and can report measurable progress with `progress: {done, total, label}`.

### Conversations with agents (migrates automatically)
- Each agent's single chat thread becomes a conversation titled from its first message, and each Slack thread with an agent becomes its own conversation. These existing ones stay **shared** (everyone could see them before). No message is moved, copied or rewritten; each only gets its conversation id.
- New conversations are **private** to whoever starts them (and workspace owners) until they share them. The server checks this on every read, send, stop and file download, and live updates carry only ids, never message text.
- Each conversation has its own Claude Managed Agents session, so a new conversation starts fresh. Lessons and instructions apply to all of them.
- Webhook and polling agents: each message now has a `chat_id`; pass it back on `POST /api/agent/messages` to answer in the right conversation.

### Adding or changing skills
Skills are folders in `agent-skills/<name>/` with a `SKILL.md` (plus `scripts/` and `references/`). Commit a change and redeploy. The next time an agent using that skill is synced, Hive uploads the new version automatically.

## Odoo (Lebanon, Cyprus and UAE books)

Agents reach Odoo through Hive, not directly. Hive holds the key, runs each call itself, and applies the rules:

- **Reads** (search, read, counts) run immediately.
- **Changes** (create, write, post, reconcile, delete) pause the agent and show an **Approve / Reject** card on the task, with the exact payload. **Approve all for this run** lets the rest of that run's changes through.
- **Off-limits:** chart of accounts, journals, taxes, users, groups and system settings (`ir.*`) can never be changed by an agent.
- Every change is logged in **Settings → Odoo changes by agents**, with who approved it.

### Railway variables

| Variable | Value |
|---|---|
| `ODOO_API_KEY` | In Odoo: avatar → **My Profile** → **Account Security** → **New API Key**. Use a user with accounting access to all companies. |
| `ODOO_URL` | Optional, default `https://presentail.odoo.com` |
| `ODOO_DB` | Optional, default `presentail` |

Then **Settings → Odoo → Test connection** should list Presentail LTD, Presentail SAL and Presentail Flowers Trading.

### Turning on an accountant
Open the agent → **Skills & tools** → tick **Odoo** and its skills, then **Save & sync**. The *hive-odoo* guide skill is added automatically. It tells the agent to use the Odoo tool wherever an older skill mentions Make scenarios.

| Agent | Suggested skills |
|---|---|
| Lebanon Accountant | Toters Fee Bills, Blom Bank Feed, Sal Supplier Statement Reconciliation, Intercompany Sal Ltd, PDF, Excel |
| Cyprus Accountant | Odoo Supplier Invoices, Intercompany Sal Ltd, PDF |
| Auditor | Blom Bank Feed, Sal Supplier Statement Reconciliation, Odoo Supplier Invoices (it reads freely; any fix it proposes waits for you) |
