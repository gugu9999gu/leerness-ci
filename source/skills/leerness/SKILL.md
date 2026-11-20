---
name: leerness
description: Read an existing Leerness project's handoff, trace a requirement to its rules and Git evidence, or prepare a review brief in chat.
---

# Leerness

Use the current checkout and the host's file and Git readers. Return the requested handoff or review brief in chat. A project can have partial or no Leerness state.

1. Start with the user's request and applicable project instructions. In the existing `.leerness/` workspace, consult `session-handoff.md` or `current-state.md` for leads. If the project uses legacy `.harness/`, read the relevant original there. When both exist, follow the project's recorded authority. Surface conflicts or missing authority. Keep records in place.
2. Follow the task ID or a narrow search to the original request (often `user-requests.json`), the relevant entries in `rules.md`, decisions, and task evidence. Quote the relevant requirement exactly and cite its file, identifier or line. Attribute handoff summaries to their source. Avoid traversing archives, backups, secret files or unrelated history.
3. Identify the branch and commit. Use `git --no-optional-locks status --short --branch` so reading status does not refresh the index on disk. Use `git --no-optional-locks diff --no-ext-diff --no-textconv` with a relevant path, adding `--cached` for staged changes. Note untracked paths separately. Inspect only relevant non-secret changes. Link a test or review result to its recorded commit and scope. Distinguish historical results, checks run in this session and missing evidence. In a non-Git project, report that Git evidence is unavailable.
4. Give the next agent the original requirement, applicable rule, observed changes, verification status and next action, with source paths. For a review brief, add the candidate revision, acceptance checks and unresolved questions. Preserve any explicit user-selected model, version, provider and role. If it cannot be called, report the reason and wait for the user's explicit choice before substituting. A brief is not an executed review.

Default to reads. Do not install or invoke a package, start MCP, load secrets, create settings, update state or launch a reviewer as part of a handoff. If asked to write an artifact, name the destination first and limit edits to that authorization. Concurrent ledger writes, locks and task transitions belong to the project's CLI workflow. In Skill-only mode, report when a requested operation needs it.
