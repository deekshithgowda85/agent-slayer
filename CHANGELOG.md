# Changelog

All notable changes to Agent Slayer are documented here.

## [1.0.0] - 2026-03-19

### Added

- Setup wizard — single page UI for framework, database, CI/CD config
- Global Copilot instructions auto-applied on startup
- Support for FastAPI, Django, Express, Spring Boot
- Support for PostgreSQL, MySQL, MongoDB
- Support for GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure Pipelines
- 8 prompt skill files:
  - new-endpoint
  - new-feature
  - db-query
  - security-review
  - write-tests
  - create-migration
  - code-review
  - debug-and-fix
- @skills chat participant with keyword intent detection
- Multi-tenant org_id scoping rules toggle
- Strict error format toggle { error, code, detail }
- Token-optimized instruction builder
- Cross-platform prompt installer (Windows, Mac, Linux)
- Live config reload on settings change
- Status command showing current config
