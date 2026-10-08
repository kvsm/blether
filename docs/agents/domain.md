# Domain Docs

How the engineering skills should consume this project's domain documentation when exploring the codebase.

## Where the docs live

Blether's design docs are private. They live in the private repo [`kvsm/blether-internal`](https://github.com/kvsm/blether-internal), cloned next to this one as `../blether-internal`:

- **`CONTEXT.md`**: the glossary.
- **`docs/adr/`**: the decisions behind the design. Code comments that cite an ADR ("ADR 0008") mean these.
- **`docs/research/`**: research behind decisions.

If `../blether-internal` isn't there, **proceed silently**. Don't flag its absence, and don't recreate the docs in this repo.

## Keep design and commercial thinking out of this repo

This repo is public. Anything containing a design or commercial decision, or the reasoning behind one, goes in `blether-internal`, never here. That covers glossary changes, ADRs, research, plans for a hosted service, and pricing. The `/domain-modeling` skill's "repo root" and `docs/adr/` mean `../blether-internal`.

User docs stay here: `README.md`, `docs/self-hosting.md`, and the npm package's README. They describe how Blether works, not why it was designed that way.

## Before exploring, read these

- **`../blether-internal/CONTEXT.md`**.
- **`../blether-internal/docs/adr/`**: read ADRs that touch the area you're about to work in.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

## Public issues and PRs

Issues and PRs in `kvsm/blether` are public too. Keep their bodies to what needs doing, and link to an ADR by number rather than restating its reasoning. Keep commercial plans out of them altogether.
