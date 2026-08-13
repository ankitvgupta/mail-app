# Feature eval fixtures

One directory per AI feature, with N JSON fixtures inside. Each fixture is
graded by the LLM judge against its rubric.

## Directory layout

```
feature-fixtures/
├── draft-generator/         # IMPLEMENTED — 3 fixtures, baseline 4/3/2
│   ├── dg-1-direct-question.json
│   ├── dg-2-scheduling.json
│   └── dg-3-decline.json
├── calendaring-agent/       # IMPLEMENTED — 3 fixtures, baseline 9/10/10
│   ├── ca-1-explicit-scheduling.json
│   ├── ca-2-not-scheduling.json
│   └── ca-3-ambiguous-time.json
├── archive-ready-analyzer/  # IMPLEMENTED — 2 fixtures, baseline 10/10
│   ├── ar-1-resolved-thread.json
│   └── ar-2-open-question.json
├── sender-lookup/           # TODO (lives in mail-ext-web-search extension)
├── style-profiler/          # TODO (interface needs GmailClient mock)
├── analysis-edit-learner/   # TODO (interface takes user-edit deltas)
└── draft-edit-learner/      # TODO (interface takes user-edit deltas)
```

Baselines live at `tests/evals/baselines/<feature>.json` and are created
the first time you run `--update-baseline`.

## Fixture shape

```json
{
  "id": "unique-stable-id",
  "description": "one-line description of what this fixture tests",
  "input": { /* feature-specific shape — see tests/evals/features/<name>.ts */ },
  "rubric": "Markdown checklist of what good output looks like.\n- bullet\n- bullet",
  "expectedMinScore": 7
}
```

The `input` schema is defined by the feature's runFixture function in
`tests/evals/features/<feature>.ts`. The judge sees the rubric + the
feature's output — never the rubric inputs or expected score.

## Adding a feature

1. Create `tests/evals/features/<feature>.ts` exporting
   `async function runXxxFixture(input: unknown, fixtureId: string): Promise<string>`.
2. Register it in `tests/evals/feature-evals.ts` under `FEATURES`.
3. Drop fixture JSON files in `feature-fixtures/<feature>/`.
4. Run `npm run eval:features -- --feature <name> --update-baseline`
   once to capture the initial baseline.
5. Remove the feature from `TODO_FEATURES` in `feature-evals.ts`.

## Running

```bash
# One feature:
npm run eval:features -- --feature draft-generator

# All registered features:
npm run eval:features -- --all

# Capture baseline (use only after intentional improvements):
npm run eval:features -- --feature <name> --update-baseline
```

Requires `ANTHROPIC_API_KEY` in `.env.local`. Local-only — never CI.

## Status note (May 2026)

The previous "Electron-imports break tsx" limitation has been **resolved**
via the data-dir lazy refactor — `src/main/data-dir.ts` defers the
`electron` require to call-time, so every AI service module now imports
cleanly outside an Electron context. Adding a new feature is just:
runner wrapper + fixtures + register. No per-service surgery needed.
