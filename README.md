<p align="center">
	<img
		src="https://capsule-render.vercel.app/api?type=waving&height=220&color=0:0f172a,30:1e293b,65:0b6bcb,100:14b8a6&text=Agent%20Slayer&fontColor=ffffff&fontSize=50&fontAlignY=36&desc=Your%20Rules.%20Copilot%20Obeys.&descAlignY=58"
		alt="Agent Slayer header"
	/>
</p>

<p align="center">
	<a href="https://marketplace.visualstudio.com/items?itemName=deekshithgowda85.agent-slayer"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-0b6bcb?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" /></a>
	<a href="https://github.com/deekshithgowda85/agent-slayer/releases"><img src="https://img.shields.io/github/v/release/deekshithgowda85/agent-slayer?style=for-the-badge&color=14b8a6" alt="Latest Release" /></a>
	<a href="https://github.com/deekshithgowda85/agent-slayer"><img src="https://img.shields.io/github/stars/deekshithgowda85/agent-slayer?style=for-the-badge&color=1d4ed8" alt="GitHub Stars" /></a>
	<a href="LICENSE"><img src="https://img.shields.io/github/license/deekshithgowda85/agent-slayer?style=for-the-badge&color=334155" alt="License" /></a>
</p>

<p align="center">
	<img
		src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=19&pause=1100&color=0B6BCB&center=true&vCenter=true&width=940&lines=Install+once.+Keep+your+coding+rules+everywhere.;Auto-detect+stack+on+workspace+open.;Prompt+Sidebar+%2B+Marketplace+%2B+Global+Copilot+instructions."
		alt="Animated summary"
	/>
</p>

# Agent Slayer

Agent Slayer is a VS Code extension that configures and enforces your Copilot workflow across projects.
It combines setup automation, stack-aware prompt recommendations, and a prompt marketplace in one extension.

## Quick Links

- [Downloads](#downloads)
- [What It Does](#what-it-does)
- [Auto-Detect Stack](#auto-detect-stack)
- [Commands](#commands)
- [Configuration](#configuration)
- [Version Archive](#version-archive)

## Downloads

- VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=deekshithgowda85.agent-slayer
- Direct VSIX download (v1.1.0): [versions/agent-slayer-1.1.0.vsix](versions/agent-slayer-1.1.0.vsix)
- All packaged versions: [versions/](versions/)

## What It Does

1. Runs setup once and stores your preferred stack conventions.
2. Applies global Copilot instructions automatically on startup.
3. Auto-detects project stack and recommends matching prompts.
4. Lets you manage prompts from a sidebar and marketplace.

### Supported Stacks

| Framework    | Language             |
| ------------ | -------------------- |
| FastAPI      | Python 3.11+         |
| Django + DRF | Python               |
| Express      | Node.js / TypeScript |
| Spring Boot  | Java / Kotlin        |

| Database   | Typical ORM / Driver           |
| ---------- | ------------------------------ |
| PostgreSQL | AsyncSQLAlchemy / Prisma / JPA |
| MySQL      | AsyncSQLAlchemy / Prisma / JPA |
| MongoDB    | Motor / Mongoose / Spring Data |

### Prompt Skills

| Prompt              | Purpose                            |
| ------------------- | ---------------------------------- |
| `/new-endpoint`     | Build complete API endpoint flow   |
| `/new-feature`      | Build end-to-end feature slices    |
| `/db-query`         | Create safe, scoped query patterns |
| `/security-review`  | Run security-focused review pass   |
| `/write-tests`      | Generate broad test coverage       |
| `/create-migration` | Plan and generate migrations       |
| `/code-review`      | Perform deep review with findings  |
| `/debug-and-fix`    | Diagnose and fix runtime failures  |

## Auto-Detect Stack

Auto-detection initializes during extension activation and checks all open workspace folders.
It also runs when a new folder is added to a multi-root workspace.

Behavior:

- Detects stack markers from `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, and `pom.xml`.
- Updates detection snapshot on startup.
- Shows the recommendation panel when a workspace is detected for the first time or when stack composition changes.

## Commands

| Command                                     | Description                         |
| ------------------------------------------- | ----------------------------------- |
| `Agent Slayer: Open Setup`                  | Open setup wizard                   |
| `Agent Slayer: Re-run Setup`                | Reset and reopen setup wizard       |
| `Agent Slayer: Install Global Instructions` | Reapply global instructions         |
| `Agent Slayer: Install Prompt Files`        | Reinstall prompt files              |
| `Agent Slayer: Reset to Defaults`           | Clear configured instruction state  |
| `Agent Slayer: Show Status`                 | Print current state in output panel |

## Configuration

| Setting                            | Default      | Options                                  |
| ---------------------------------- | ------------ | ---------------------------------------- |
| `agentSlayer.frontendFramework`    | `none`       | none, react, nextjs, vue, angular        |
| `agentSlayer.stack`                | `fastapi`    | fastapi, django, flask, nodejs           |
| `agentSlayer.database`             | `postgresql` | postgresql, mysql, mongodb, sqlite       |
| `agentSlayer.cicd`                 | `["github"]` | github, gitlab, jenkins, circleci, azure |
| `agentSlayer.multiTenant`          | `true`       | true, false                              |
| `agentSlayer.strictErrorFormat`    | `true`       | true, false                              |
| `agentSlayer.autoInstallOnStartup` | `true`       | true, false                              |
| `agentSlayer.orgIdField`           | `org_id`     | any string                               |
| `agentSlayer.testFramework`        | `pytest`     | pytest, jest, unittest                   |

## Version Archive

Packaged VSIX files are stored in [versions/](versions/) for direct repository downloads.
See [versions/README.md](versions/README.md) for a version-by-version index.

## Requirements

- VS Code 1.100.0 or higher
- GitHub Copilot extension installed and active

## Release Notes

See [CHANGELOG.md](CHANGELOG.md).

## Contributing

Issues and PRs are welcome: https://github.com/deekshithgowda85/agent-slayer/issues

## License

MIT. See [LICENSE](LICENSE).
