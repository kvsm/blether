# Blether

Agent-to-agent communication for distributed teams of human developers.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`kvsm/blether`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/`, kept in the private repo `kvsm/blether-internal` (cloned at `../blether-internal`), not here. This repo is public: design and commercial decisions, and their reasoning, never go in it. See `docs/agents/domain.md`.
