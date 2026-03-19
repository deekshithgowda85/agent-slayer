# Agent Slayer ⚔️

> Your rules. Copilot obeys.

Stop explaining your stack to Copilot on every single project.
Install once → setup wizard opens → pick your framework and database →
Copilot follows your rules automatically, forever.

---

## Why Agent Slayer?

Every time you start a new project Copilot forgets everything.
It doesn't know your stack. It doesn't know your patterns.
It doesn't know you always use async/await, org_id scoping,
Pydantic v2, or that errors must return `{ error, code, detail }`.

You end up repeating yourself. Every. Single. Project.

**Agent Slayer fixes this.**

Configure once. Works everywhere. Copilot finally knows who's boss.

---

## Quick Start

1. Install **Agent Slayer** from the Extensions panel
2. Setup wizard opens automatically
3. Pick your framework, database, and CI/CD platform
4. Click **Apply & Install**
5. Done — Copilot now follows your rules on every project

---

## Supported Stacks

### Frameworks

| Framework    | Language             |
| ------------ | -------------------- |
| FastAPI      | Python 3.11+         |
| Django + DRF | Python               |
| Express      | Node.js / TypeScript |
| Spring Boot  | Java / Kotlin        |

### Databases

| Database   | ORM / Driver                   |
| ---------- | ------------------------------ |
| PostgreSQL | AsyncSQLAlchemy / Prisma / JPA |
| MySQL      | AsyncSQLAlchemy / Prisma / JPA |
| MongoDB    | Motor / Mongoose / Spring Data |

### CI/CD Platforms

- GitHub Actions
- GitLab CI
- Jenkins
- CircleCI
- Azure Pipelines

---

## Features

### Setup Wizard

Opens automatically on first install. Single page UI — pick your
framework, database, CI/CD platform and toggle rules on/off.
Reopen anytime via Command Palette.

### Global Copilot Instructions

Automatically injects your stack rules into every Copilot suggestion
across all projects. No per-project config. No manual prompting.

### 8 Skill Prompt Files

Reusable step-by-step workflows for every common task.

| Command             | What it does                                                  |
| ------------------- | ------------------------------------------------------------- |
| `/new-endpoint`     | Full API endpoint — schema → model → CRUD → router → tests    |
| `/new-feature`      | End-to-end feature — plan → data → API → logic → tests → docs |
| `/db-query`         | Safe scoped database queries with N+1 prevention              |
| `/security-review`  | Full security audit — CRITICAL/HIGH/MEDIUM/LOW with fixes     |
| `/write-tests`      | Complete test coverage — happy path + 401 + 403 + 404 + 422   |
| `/create-migration` | Alembic / Prisma / Flyway migrations with rollback            |
| `/code-review`      | Deep code review — bugs, performance, design issues           |
| `/debug-and-fix`    | Stack trace reading + error diagnosis + fixes                 |

### @skills Chat Participant

Examples:

- `@skills create a new endpoint for sprint tracking`
- `@skills review this function for security issues`
- `@skills write tests for the auth module`
- `@skills debug this stack trace`

### Multi-Tenant Scoping

Toggle on org_id scoping — Copilot automatically adds
`WHERE org_id = :org_id` to every DB query. org_id always
injected from JWT, never from request body.

### Live Config Reload

Change any setting → Copilot instructions update instantly.
No restart needed.

---

## Commands

| Command                                     | Description                         |
| ------------------------------------------- | ----------------------------------- |
| `Agent Slayer: Open Setup`                  | Open the setup wizard               |
| `Agent Slayer: Re-run Setup`                | Reset and reopen setup wizard       |
| `Agent Slayer: Install Global Instructions` | Reapply all Copilot rules           |
| `Agent Slayer: Install Prompt Files`        | Reinstall skill prompt files        |
| `Agent Slayer: Reset to Defaults`           | Clear all Copilot instructions      |
| `Agent Slayer: Show Status`                 | Show current config in output panel |

---

## Configuration

All settings are written automatically by the Setup Wizard.
You can also edit them manually in VS Code settings:

| Setting                            | Default      | Options                                  |
| ---------------------------------- | ------------ | ---------------------------------------- |
| `agentSlayer.frontendFramework`    | `none`       | none, react, nextjs, vue, angular        |
| `agentSlayer.stack`                | `fastapi`    | fastapi, django, flask, nodejs           |
| `agentSlayer.database`             | `postgresql` | postgresql, mysql, mongodb, sqlite       |
| `agentSlayer.cicd`                 | `["github"]` | github, gitlab, jenkins, circleci, azure |
| `agentSlayer.multiTenant`          | `true`       | true / false                             |
| `agentSlayer.strictErrorFormat`    | `true`       | true / false                             |
| `agentSlayer.autoInstallOnStartup` | `true`       | true / false                             |
| `agentSlayer.orgIdField`           | `org_id`     | any string                               |
| `agentSlayer.testFramework`        | `pytest`     | pytest, jest, unittest                   |

---

## How Skill Files Work

After install, prompt files are copied to your global VS Code
prompts folder. Use them in Copilot Chat:

- `/new-endpoint` create POST /sprints with name and start_date
- `/write-tests` generate tests for routers/sprints.py
- `/security-review` (select code first, then run this)
- `/debug-and-fix` (paste your stack trace)

Files are installed at:

- **Windows:** `%APPDATA%\\Code\\User\\prompts\\`
- **Mac:** `~/Library/Application Support/Code/User/prompts/`
- **Linux:** `~/.config/Code/User/prompts/`

---

## Requirements

- VS Code 1.100.0 or higher
- GitHub Copilot extension installed and active

---

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

---

## License

MIT — see [LICENSE](LICENSE).

---

## Contributing

Issues and PRs welcome at
https://github.com/agentslayer/agent-slayer

---

_Agent Slayer — Your rules. Copilot obeys._
