# A/B benchmark run — continuation/orientation

Concrete, reproducible protocol for the experiment
`c41c1fd8-aa7e-4f6a-8e1e-14dea408fd63` (scenario `continue-orientation`).

Goal: measure whether the Hub reduces total model tokens when a **fresh agent
session** has to get oriented and name the next step — the core multi-session
use case. General rules: see `BENCHMARKING.md`.

## Fixed task (identical for both variants)

> You are a new agent session on the Waymark project. Without any prior
> conversation, produce: (1) a 5–8 line summary of the current project state,
> (2) the single most relevant next implementation step, (3) one risk to watch.
> Stop after producing this — do not implement anything.

Freeze this wording. Use the same model, client, and repo commit for all runs
in one cohort. Never mix providers/models/clients or exact/estimated runs.

## Acceptance test (quality gate)

A run is `success=true` only if the output:
- correctly names the v2 direction (provider-neutral Agent Context Hub) **and**
- names a next step consistent with `docs/TZ_V2.md` stages **and**
- contains no claim contradicted by the repo (e.g. "12 tools", "no tests").

Score `result_quality` 0–100 by how complete/accurate (2) and (3) are.

## Variant procedures

**without_hub** — disable the Hub so the agent must read files cold:
1. In `~/.codex/config.toml` comment out `[mcp_servers.waymark]`; remove the
   project `.codex/config.toml`. Restart Codex.
2. New session, paste the fixed task. Agent reads docs/git/memory files itself.
3. Capture usage (below). Restore the config afterwards.

**with_hub** — Hub available, agent starts with one call:
1. Restore `[mcp_servers.waymark]` (default core profile is enough). Restart.
2. New session, paste the fixed task. Agent calls
   `workspace_resume(project_id="D--Projects-WayMark", task=<the task>)` first,
   reads detail by id only if needed.
3. Capture usage.

Run each variant **≥5 times** in separate sessions.

## Where to get real usage numbers

Claude Code does not expose its own token counts to the agent, so use a client
that reports usage:
- **Codex** writes per-turn usage to `~/.codex/logs_2.sqlite`. Sum `input_tokens`
  and `output_tokens` for the session → `measurement=exact`.
- **Anthropic API runs** return `usage` (input/output/cache) per call →
  `measurement=exact`.
- If neither is available, estimate from serialized prompt sizes and mark
  `measurement=estimated`. Never mix exact and estimated in one cohort.

## Recording a run

```powershell
npm run benchmark -- record `
  --experiment-id "c41c1fd8-aa7e-4f6a-8e1e-14dea408fd63" `
  --variant without_hub `   # or with_hub
  --provider openai --model "<model-id>" --client codex `
  --measurement exact `
  --input-tokens <N> --output-tokens <N> `
  --tool-calls <N> --duration-ms <N> `
  --result-quality <0-100> --success true
```

Richer runs (files read, repeated files, clarifications) via
`--file run.json` — see the JSON example in `BENCHMARKING.md`.

## Reading the result

```powershell
npm run benchmark -- summary  --id "c41c1fd8-aa7e-4f6a-8e1e-14dea408fd63"
npm run benchmark -- complete --id "c41c1fd8-aa7e-4f6a-8e1e-14dea408fd63"
```

`net_token_saving_percent` = (median_without − median_with) / median_without × 100.

Targets: **≥70%** median net saving on the full continuation scenario and
**≥90%** reduction of the orientation context payload itself, with quality and
success rate held comparable (20% is the absolute floor, not the goal). Token
reduction alone does not pass. The recorded estimated cohort
(`scripts/benchmark-orientation.cjs`) measured **74.9%** / **91.5%**.
