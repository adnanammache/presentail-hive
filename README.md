# Presentail Hive

Presentail's hive of AI agents: see every agent, what it's working on, what's scheduled, and talk to it. Planned home: `hive.presentail.com`.

- **Dashboard**: what needs you (tasks waiting for review or blocked), upcoming scheduled runs, agent status and recent activity.
- **Agents that do real work**: agents can run as Claude Managed Agents with Presentail's skills (`agent-skills/`), a private sandbox and approved integrations (Wafeq first). Tasks show the live run, approvals and cost. See DEPLOY.md.
- **Agents**: one place for all your agents: Claude agents, Make scenarios, Replit apps, n8n flows, your own scripts, even people.
- **People and teams**: profiles with photos, a Team & agents directory where teams hold people and AI agents together (with team leads), invitations, and access you can turn off without losing history.
- **Tasks for people and agents**: My tasks, All tasks and Projects share one Board/List (Backlog → Ready → In progress → Needs review → Done), with blockers kept separate from the stage. A task has one assignee, a person or an AI agent; assigning never starts an agent (Create & start does). New tasks are written in a bottom-right composer that keeps your draft.
- **Recurring tasks**: schedules (daily, selected weekdays, every n weeks, monthly incl. last day, quarterly, yearly, chosen months) in each schedule's own time zone. Each occurrence creates a normal task for a person or an agent, with its own reporting period and due date, and starts the agent if asked. Agents set these up themselves from a chat ("Every Monday at 9 AM Dubai time, check outstanding supplier invoices"). See DEPLOY.md → Recurring tasks.
- **Inbox / chat**: a conversation thread with every agent. Claude agents reply live. Webhook agents can reply synchronously or later through the API.
- **Odoo, safely**: agents read Odoo freely. Every create/write/post/reconcile waits for Approve in Hive (or *Approve all for this run*), configuration is off-limits, and every change is logged with who approved it. Hive holds the key (`ODOO_API_KEY`).
- **Org chart**: Presentail's teams and agents as a tree, with status, open tasks and AI spend per agent.
- **AI spend**: month-to-date cost of agent runs, daily for 30 days, by team and by agent. It appears on the dashboard, team headers and agent cards.
- **Agent output files**: reports and spreadsheets an agent saves are downloadable from the task.
- **Slack alerts**: messages you when an agent needs approval, finishes a turn, gets stuck, or a scheduled workflow fails (`SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL`). Links open the task directly (`#/tasks/<id>`).
- **Settings**: what's connected, how to connect the rest, and a *Send test alert* button.
- **Install on your phone**: Add to Home Screen opens Hive as an app.
- **Live updates**: the UI refreshes itself (Server-Sent Events) whenever an agent replies or moves a task.

## Quick start

```bash
npm install
npm run dev          # API on :3001, UI on http://localhost:5173
```

In development, the first launch fills the database with sample Presentail agents and workflows (Ledger, Odoo Operator, Morning Briefer and so on) so there's something to look at. Edit or delete them in the UI, or run `npm run seed` to reset to the samples. To start empty, set `NO_SEED=1` and delete `data/`.

Production (see **[DEPLOY.md](DEPLOY.md)** for the step-by-step Railway setup):

```bash
npm run build
APP_PASSWORD=choose-one ANTHROPIC_API_KEY=sk-ant-... npm start   # serves UI + API on :3001
```

### Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Powers Claude agents: chat-only agents, and Claude Managed Agents that run tasks with skills and tools. |
| `ODOO_API_KEY` (+ optional `ODOO_URL`, `ODOO_DB`) | Odoo for agents, executed by Hive with approvals. |
| `RESEND_API_KEY`, `MAIL_FROM` | Optional: email invitations to new people (otherwise Hive gives you the link to share). |
| `WAFEQ_API_KEY` | Wafeq integration for managed agents. Agents reach Wafeq through Hive: reads are live, writes are queued and approved as one batch. The key never leaves Hive. |
| `DEFAULT_CLAUDE_MODEL` | Model used when an agent doesn't set one (default `claude-opus-5`). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Turns on **Continue with Google** sign-in (see DEPLOY.md). |
| `ALLOWED_EMAIL_DOMAIN` | Google accounts allowed in (default `presentail.com`, comma-separated). |
| `ALLOWED_EMAILS` | Extra individual addresses allowed in. |
| `SLACK_BOT_TOKEN` / `SLACK_ALERT_CHANNEL` | Slack alerts: a bot token with `chat:write`, and your member ID (for DMs) or a channel ID. |
| `SESSION_SECRET` | Signs the login cookie. Set a long random value in production. |
| `APP_PASSWORD` | Protects the dashboard with a password (browser login prompt, any username). Fallback sign-in when Google isn't configured. Production refuses to start with neither. |
| `PUBLIC_URL` | Public base URL (e.g. `https://hive.presentail.com`), included in webhook payloads so agents know where to call back. |
| `PORT` | HTTP port (default `3001`). |
| `DB_PATH` | SQLite file (default `./data/hive.db`, or `hive.db` on the Railway volume when one is attached). |

Requires Node ≥ 22.5. It uses the built-in `node:sqlite`, so there are no native modules to build.

## How agents connect

Every agent gets its own API token (Agent page → **Connect**). Work reaches an agent in one of three ways:

1. **Claude agents** (`platform = claude`): answered directly through the Claude API using the agent's system prompt and model. The last 40 messages of the thread are the context.
2. **Webhook agents** (Make, n8n, Replit, custom): every message, task and workflow run is `POST`ed as JSON to the agent's webhook URL:

   ```json
   {
     "event": "message | task.assigned | workflow.run",
     "message": { "id": 12, "body": "…" },
     "task": { "id": 7, "title": "…", "description": "…" },
     "run_id": 3,
     "agent": { "id": 2, "name": "Odoo Operator" },
     "callback": { "api": "https://your-host/api/agent" }
   }
   ```

   If the webhook answers `{"reply": "…"}`, the reply appears in the chat. For tasks, the reply is also saved as the task result and the task moves to **Needs review**. In Make, a *Webhook response* module does this.
3. **Polling agents**: anything without a webhook calls the Agent API on its own schedule.

### Agent API

All endpoints take `Authorization: Bearer <agent token>`.

| Method & path | What it does |
|---|---|
| `GET /api/agent/me` | The agent's own profile |
| `POST /api/agent/heartbeat` | `{ "status": "active" \| "idle" \| "error" }`. Also updates "last seen". |
| `GET /api/agent/tasks?status=todo,in_progress` | The agent's tasks (default: todo, in progress, blocked) |
| `POST /api/agent/tasks` | Create a task (for itself, or for another agent via `agent_id`) |
| `PATCH /api/agent/tasks/:id` | `{ "status": "done", "result": "…" }`. Finishing a workflow's task marks that run as successful; `blocked` marks it failed. |
| `GET /api/agent/messages?since_id=0` | New messages in its thread |
| `POST /api/agent/messages` | `{ "body": "…" }` posts into the chat |
| `PATCH /api/agent/runs/:id` | `{ "status": "success" \| "failed", "output": "…" }` |
| `POST /api/agent/recurring/:tool` | Recurring-task tools (`GET /api/agent/recurring/tools` lists them). Pass `message_id` or `task_id` for changes; see DEPLOY.md → Recurring tasks. |

## Project layout

```
server/            Express API + scheduler (plain ESM JavaScript)
  app.js           dashboard API and Agent API routes
  dispatch.js      delivery to agents (Claude API / webhook / queue)
  scheduler.js     starts the durable schedule ticker; finishes workflow runs
  recurring.js     recurrence rules, time zones, reporting periods, deadlines (croner)
  schedules.js     recurring tasks: permissions, occurrences, delivery, retries
  scheduleTools.js the recurring-task tools managed agents get
  db.js            SQLite schema (node:sqlite)
  seed.js          sample data
  api.test.js      API tests: npm test
web/               React UI (Vite)
  pages/           Dashboard, AllTasks (All / My tasks), Projects, Project, Agents (Team & agents), AgentDetail, Workflows (Recurring), Inbox
  components/      forms, chat, UI primitives
```
