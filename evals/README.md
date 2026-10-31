# Evals

A rubric suite for measuring whether the agent actually finishes tasks — not whether it says it did.

- `tasks.json` — 30 real tasks with 3–4 checkable rubric points each.
- `run.mjs` — grades exported chat transcripts with the Worker's `/judge` endpoint and reports **pass@3** (a task passes if any of up to three attempts scores ≥ 0.80).

```bash
node evals/run.mjs --validate                 # offline: checks the suite shape
node evals/run.mjs                            # grades evals/transcripts/*.md
node evals/run.mjs --worker https://your-worker --transcripts ./runs
```

Name transcripts `<taskId>-<attempt>.md`, e.g. `t04-1.md`. Get one by running the task in the panel and using ☰ → **Export .md**. Three exports per task give you pass@3.

Why judge the transcript and not the final reply: an agent that claims success it did not achieve would otherwise score perfectly. The judge is instructed to accept only steps that show the action or the resulting page state, and to treat failed, blocked and "no visible change" steps as non-evidence. That is the same failure mode WebJudge and Online-Mind2Web were built to catch.

The suite is deliberately small and self-hosted: a 30-task rubric you wrote yourself tells you more about your own agent than WebArena does, and it runs in minutes.
