# Token usage benchmarking

This document defines the Stage 1 measurement protocol for comparing agent work
with and without the Hub.

## Measurement rule

The primary metric is total model usage for the complete task:

```text
total_model_tokens =
  input_tokens
  + output_tokens
  + hub_llm_input_tokens
  + hub_llm_output_tokens
```

`input_tokens` already includes tool schemas, prompts, retrieved context and
memory-write requests sent to the agent model. Do not add `context_tokens` or
tool-schema tokens to the total a second time.

`cached_input_tokens` is diagnostic metadata. It is not subtracted unless a
future cost-specific metric explicitly defines provider cache pricing.

## Exact and estimated data

- Use `measurement=exact` only when token counts come from the provider or
  client usage report.
- Use `measurement=estimated` for locally calculated counts.
- Never combine exact and estimated runs in one result.
- Never combine different providers, models or clients in one result.

The `experiment_summary` tool enforces these cohort boundaries.

## Running an experiment

1. Create an experiment with `experiment_create`.
2. Freeze the repository state and task instructions.
3. Run the scenario without the Hub.
4. Restore the same initial state.
5. Run the scenario with the Hub.
6. Submit each result with `usage_report`.
7. Repeat both variants at least five times.
8. Read the grouped result with `experiment_summary`.
9. Mark the experiment completed with `experiment_update`.

The same workflow is available from the command line:

```powershell
# Create an experiment
npm run benchmark -- create `
  --name "Continuation benchmark" `
  --scenario "continue-bugfix" `
  --project-id "D--Projects-ClaudePlus" `
  --target-runs 5

# Record one run from flags
npm run benchmark -- record `
  --experiment-id "<experiment-id>" `
  --variant without_hub `
  --provider openai `
  --model "<model-id>" `
  --client codex `
  --measurement exact `
  --input-tokens 12000 `
  --output-tokens 1800 `
  --duration-ms 90000 `
  --success true

# Record a richer run from JSON
npm run benchmark -- record --file .\run-with-hub.json

# Read the report and close the experiment
npm run benchmark -- summary --id "<experiment-id>"
npm run benchmark -- complete --id "<experiment-id>"
```

Use `DB_PATH` to run against a separate benchmark database:

```powershell
$env:DB_PATH = "D:\tmp\claudeplus-benchmark.db"
npm run benchmark -- list
```

The installed package exposes the same CLI as `claudeplus-benchmark`.
For repository development, run `npm run build` after source changes before
using `npm run benchmark`. The benchmark command itself does not rebuild
`dist`, so it can run while the MCP server is active on Windows.

Example JSON run:

```json
{
  "experiment_id": "<experiment-id>",
  "variant": "with_hub",
  "provider": "openai",
  "model": "<model-id>",
  "client": "codex",
  "measurement": "exact",
  "input_tokens": 8500,
  "output_tokens": 1400,
  "hub_llm_input_tokens": 0,
  "hub_llm_output_tokens": 0,
  "context_tokens": 900,
  "tool_calls": 14,
  "files_read": ["src/server.ts", "src/tools/memory.ts"],
  "repeated_files": 1,
  "clarification_count": 0,
  "duration_ms": 62000,
  "result_quality": 95,
  "success": true
}
```

## Required controls

- Same provider, model and client within a cohort.
- Same task statement and acceptance test.
- Same initial repository state.
- Same tool availability except for the Hub itself.
- Separate sessions for every run.
- Record failures instead of silently discarding them.

## Recommended fields

Every run should provide:

- `experiment_id`;
- `variant`;
- `provider`;
- `model`;
- `client`;
- `measurement`;
- `input_tokens`;
- `output_tokens`;
- `hub_llm_input_tokens` and `hub_llm_output_tokens` when applicable;
- `context_tokens` or `context_text`;
- `tool_calls`;
- `files_read`;
- `repeated_files`;
- `clarification_count`;
- `duration_ms`;
- `result_quality`;
- `success`;
- notes about deviations.

## Interpreting the result

```text
net_token_saving =
  median_without_hub
  - median_with_hub

net_token_saving_percent =
  net_token_saving / median_without_hub * 100
```

A positive result means the Hub reduced model usage. Token reduction is not
sufficient by itself: result quality and success rate must remain comparable.

The MVP target is at least 20% median net token saving on continuation tasks.
