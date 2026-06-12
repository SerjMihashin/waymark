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
