# pi-jev-skill-picker

A Pi and [omp](https://omp.sh) extension that keeps the Agent Skills catalog out of model requests and replaces it with one ranking tool backed by Jev, TypeSafe's System One decision model.

Jev is reached two ways. With a `TYPESAFE_API_KEY` configured the extension asks [TypeSafe's System One endpoint](https://docs.typesafe.ai) directly; without one it uses [classifier.dev](https://classifier.dev), which runs the same model behind a keyless label API — no account, no key, no signup.

Skills stay loaded, so `/skill:name` keeps working. Before each agent turn the extension removes the generated `<skills>` catalog from the effective system prompt and gives the model two tools to pull skills in on demand.

`skill_search` takes a plain-language description of the task, rates every enabled skill against it, and returns the complete `SKILL.md` instructions of the skills that apply.

## What it saves

On a 137-skill catalog the generated `<skills>` block runs about 19,000 tokens, which is 87% of Pi's system prompt. Pi resends it on every request.

Both rows below use the same captured prompt and one trivial turn:

| Model | Catalog present | Catalog stripped | Saving |
|---|---|---|---|
| `gpt-6-astra` | 21,074 tokens, $0.2107 | 2,541 tokens, $0.0254 | 87.9% |
| `deepseek-v4.1-flash` | 22,377 tokens, $0.0034 | 3,434 tokens, $0.0005 | 84.6% |

One `skill_search` call over a 137-skill catalog costs about 38,600 Jev input tokens on TypeSafe, or $0.0016 at $42 per billion. Jev bills input only. Against `gpt-6-astra` that is under 1% of what a single un-stripped request wastes. The same call through classifier.dev is free inside its per-IP limits — 3,000 classifications a minute and 20,000 a day, which is about 146 searches a day at 137 skills each.

## How the ranking works

Each skill becomes its own Score question. The task goes in the shared `state`, and the skill's name and description go in that skill's own `instructions`. Jev judges each skill without seeing the others, so no keyword prefilter can drop one first.

classifier.dev has no `state` or Score questions, so the same judgement is expressed in its own terms: the task and the level definitions move into the shared criteria, each skill becomes one input, and the three levels become the labels. The position is then the mean of the label probabilities weighted by level — the same 0 to 2 scale, reached from a probability distribution.

Every skill is rated on the same three ordered levels:

| Level | Meaning |
|---|---|
| 0 | Unrelated. A different domain, tool or workflow. |
| 1 | Adjacent. Same general area, not the specific thing the task needs. |
| 2 | Directly applicable. Covers the exact tool or workflow, and changes how the task is done. |

Jev returns a probability-weighted position on those levels. Code applies the floor, sorts, and loads the winners. A skill has to lean toward "directly applicable" to be loaded, and ties break on confidence.

## Which service answers

The transport follows the key. `PI_SKILL_JEV_TRANSPORT`, or `transport` in the config file, overrides it:

| Configured | Asked first | Asked if that fails |
|---|---|---|
| `TYPESAFE_API_KEY` set | TypeSafe System One | classifier.dev |
| no TypeSafe key | classifier.dev | nothing, because TypeSafe needs a key |

Set `fallback` to `false` to keep a run on one service. With it on, a failed shard is re-asked of the other service, which for a keyed setup means skill names and descriptions leave for a shared public service. Every tool result reports which services answered and how many shards were diverted.

If no service can be asked or every request fails, `skill_search` falls back to deterministic lexical matching and says so in its result. The lexical fallback returns skill metadata and paths rather than loaded instructions, so the agent decides what to read.

## Configuration

Precedence is environment variable, then `skill-jev.json` under the agent directory — `~/.pi/agent` under Pi, `~/.omp/agent` under omp, or the active omp profile's `~/.omp/profiles/<name>/agent` — then the package default. `PI_CODING_AGENT_DIR` moves the agent directory for either harness, and `PI_SKILL_JEV_CONFIG` names the file outright.

| Setting | Environment variable | JSON field | Default |
|---|---|---|---|
| TypeSafe key | `TYPESAFE_API_KEY` | `apiKey` | none |
| classifier.dev key | `CLASSIFY_API_KEY` or `CLASSIFIER_API_KEY` | `classifyApiKey` | none |
| Transport | `PI_SKILL_JEV_TRANSPORT` | `transport` | `typesafe` when a TypeSafe key is set, else `classifier` |
| Endpoint | `PI_SKILL_JEV_ENDPOINT` | `endpoint` | the URL of the chosen transport |
| Fall back to the other service | `PI_SKILL_JEV_FALLBACK` | `fallback` | `true` |
| TypeSafe model | `PI_SKILL_JEV_MODEL` | `model` | `jev-latest` |
| Max questions per request | `PI_SKILL_JEV_SHARD_SIZE` | `shardSize` | `50` |
| Score floor, 0 to 2 | `PI_SKILL_JEV_MIN_SCORE` | `minScore` | `1.4` |
| Skills loaded per call | `PI_SKILL_JEV_MAX_SKILLS` | `maxSkills` | `3` |
| Request timeout, ms | `PI_SKILL_JEV_TIMEOUT_MS` | `timeoutMs` | `20000` |
| Description truncation | none | `descriptionLimit` | `1200` |

Both keys are optional, and either can be present on its own. The TypeSafe key is never sent to classifier.dev, which is asked with no credentials at all unless its own key is configured — that key only raises the limits, to the Pro tier's 30,000 a minute and 200,000 a day.

`endpoint` is only needed to point at a proxy; it also decides the transport by host, so naming the TypeSafe URL there gets the keyed route without any other setting.

Keep the key in the config file with `0600` permissions, or in the environment. It is never passed on a command line.

```json
{
  "apiKey": "apikey_…",
  "minScore": 1.4,
  "maxSkills": 3
}
```

Raise `minScore` if too many adjacent skills load, and lower it if a relevant skill is missed.

## Install

Under Pi, straight from the repository:

```sh
pi install git:github.com/rezhajulio/pi-jev-skill-picker
```

Or from a checkout, which is what you want while working on the extension:

```sh
git clone https://github.com/rezhajulio/pi-jev-skill-picker
pi install ./pi-jev-skill-picker
```

Add `-l` to either to record it in the project instead of your own settings. Reload an existing session with `/reload`, or start a new session.

Under [omp](https://omp.sh) the same package loads unchanged: omp reads the manifest, resolves the `@earendil-works/*` imports onto its own bundled copies, and hands the system prompt over as parts, which the extension strips the same way.

```sh
omp install github:rezhajulio/pi-jev-skill-picker
omp install ./pi-jev-skill-picker   # from a checkout, symlinked and watched
```

Either form lands in `~/.omp/plugins` and records the source there, so `omp install` again is the update path. Write the spec as `github:owner/repo`, as a full URL like `https://github.com/rezhajulio/pi-jev-skill-picker`, or as a local path — a bare `github.com/owner/repo` is not a spec omp accepts, and it fails with `Invalid package name`.

omp keeps its config in `~/.omp/agent/skill-jev.json`, reads the live skill set the session loaded instead of a per-turn snapshot, and leaves skills marked `hide: true` out of the ranking and the prompt entirely, matching omp's own rule that they stay reachable only by name. Both tools and the `skill://` pointer in the prompt are handled, so nothing is left dangling in the system prompt. Because omp does not carry an extension's `promptGuidelines` into the prompt, the catalog is replaced by one paragraph that names `skill_search` and `skill_load` rather than by nothing — anchored where the model already looked for skills.

This extension replaces `pi-skill-search`. Uninstall that one, along with its `pi-subagents` dependency if nothing else uses it. The old subagent picker forked the whole conversation into a child agent and needed a persisted session to do it. This one sends a single task string, so it needs neither.

## Tools

`skill_search` ranks and loads. It accepts:

- `task`: required plain-language description of what the agent is about to do, naming the concrete tools, services or files involved
- `maxSkills`: optional limit from 1 to 5; defaults to the configured `maxSkills`

It loads the top `maxSkills` skills in full, then lists every other skill that cleared the floor with its score and path. Nothing above the floor is hidden. A task like "review this diff and hand it to codex" puts 12 skills over 1.4, so the 9 that missed the cut are named rather than dropped.

`skill_load` loads by name and never calls Jev. It accepts:

- `names`: one to five exact skill names, as `skill_search` reported them

Use it for a skill that `skill_search` listed but did not load, or when the name is already known. Files are read straight off disk, so it costs no tokens and adds no latency.

A name that does not match returns close alternatives instead of failing:

```
No skill named 'fleece'. Did you mean 'fleet'?
```

Matching ignores case and separators, so `Fleet` and `review codex auto` resolve to `fleet` and `review-codex-auto` and load without a second call. Anything further off is reported as a suggestion for the agent to confirm. One bad name among good ones does not fail the call. The rest load, and the miss is noted at the end.

Both tools return skill content as tool results. Neither writes to the system prompt, which is what keeps the cached prefix stable across turns.

Disabled skills stay undiscoverable, because both tools work from Pi's resolved enabled-skill list.

## Development

```sh
bun install
bun run check   # typecheck and unit tests
```

Tests stub `fetch`, so they make no network calls.
