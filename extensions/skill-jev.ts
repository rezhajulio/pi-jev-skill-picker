/**
 * Keep Pi's full Agent Skills catalog out of every model request.
 *
 * Skills stay loaded, so /skill:name keeps working. Before each agent turn the
 * generated <skills> catalog is removed from the effective system prompt and
 * replaced by two tools. skill_search rates every enabled skill against the
 * current task with Jev — one Score question per skill, sharded across parallel
 * requests — and returns the full SKILL.md of the winners.
 *
 * Jev is reached two ways. With a TypeSafe key the extension asks TypeSafe's
 * System One endpoint directly; without one it uses classifier.dev, which runs
 * the same model behind a keyless label API.
 *
 * The same module runs under Pi and under omp (oh-my-pi). omp injects its own
 * coding-agent module namespace as `pi.pi`, takes the system prompt as an array
 * of parts, and keeps its agent config in ~/.omp/agent, so the parts of this file
 * that touch Pi branch on the harness it is running inside.
 */

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";

import {
	JevError,
	loadConfig,
	OMP_SKILLS_GUIDANCE,
	rankSkills,
	stripSkillCatalog,
	stripSkillCatalogParts,
	transportLabel,
	type Runtime,
	type SkillEntry,
} from "./jev.ts";
import { lexicalMatches } from "./lexical.ts";
import { didYouMean, suggestNames } from "./fuzzy.ts";

export { stripSkillCatalog, stripSkillCatalogParts };

/** The omp skill shape adds a `hide` flag to the fields both harnesses share. */
interface AnySkill extends SkillEntry {
	hide?: boolean;
}

/**
 * The slice of omp's coding-agent module namespace this extension uses. omp
 * injects it as `pi.pi`; upstream Pi has no such member, which is also how the
 * runtime is told apart.
 */
interface OmpModule {
	getActiveSkills?: () => readonly AnySkill[];
	loadSkills?: (options?: { cwd?: string }) => Promise<{ skills: readonly AnySkill[] }>;
}

function ompModule(pi: ExtensionAPI): OmpModule | undefined {
	const injected = (pi as unknown as { pi?: unknown }).pi;
	if (!injected || typeof injected !== "object") return undefined;
	const module = injected as OmpModule;
	const usable = typeof module.getActiveSkills === "function" || typeof module.loadSkills === "function";
	return usable ? module : undefined;
}

function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

function xmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function renderSkill(skill: SkillEntry, note: string): string {
	const body = stripFrontmatter(readFileSync(skill.filePath, "utf8"));
	return [
		`<skill name="${xmlAttribute(skill.name)}" location="${xmlAttribute(skill.filePath)}">`,
		note,
		`References are relative to ${skill.baseDir}.`,
		"",
		body,
		"</skill>",
	].join("\n");
}

/** Skills the model may be shown: omp keeps hidden ones loadable but unlisted. */
function toEntries(skills: readonly (AnySkill | Skill)[]): SkillEntry[] {
	return skills
		.filter((skill) => (skill as AnySkill).hide !== true)
		.map((skill) => ({
			name: skill.name,
			description: skill.description,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
		}));
}

export default function (pi: ExtensionAPI) {
	const omp = ompModule(pi);
	const runtime: Runtime = omp ? "omp" : "pi";
	let enabledSkills: SkillEntry[] = [];

	/**
	 * Under omp the live skill set is readable at any time and can change mid
	 * session, so it is re-read rather than cached from the last turn. Upstream Pi
	 * only hands skills over on before_agent_start.
	 */
	async function skillEntries(cwd: string): Promise<SkillEntry[]> {
		if (omp) {
			const live = omp.getActiveSkills?.();
			if (live) return toEntries(live);
			const loaded = await omp.loadSkills?.({ cwd });
			if (loaded) return toEntries(loaded.skills);
		}
		return enabledSkills;
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (omp) {
			enabledSkills = await skillEntries(ctx?.cwd ?? process.cwd());
			const given = event.systemPrompt as unknown;
			// Nothing to rewrite if this omp build hands no prompt over at all.
			if (typeof given !== "string" && !Array.isArray(given)) return;
			const parts = stripSkillCatalogParts(
				Array.isArray(given) ? (given as string[]) : [given as string],
				OMP_SKILLS_GUIDANCE,
			);
			// omp takes the prompt back as parts and reads a lone string as one part;
			// upstream Pi only accepts the string, so each runtime gets its own shape.
			return { systemPrompt: (parts as unknown) as string };
		}
		enabledSkills = toEntries(event.systemPromptOptions?.skills ?? []);
		return { systemPrompt: stripSkillCatalog(event.systemPrompt) };
	});

	pi.registerTool({
		name: "skill_load",
		label: "Skill Load",
		description:
			"Load named Agent Skills in full, straight from disk. Use it for a skill skill_search listed but did not load, or when you already know the exact name. A name that does not match returns close alternatives rather than failing.",
		promptSnippet: "Load Agent Skills by exact name",
		promptGuidelines: [
			"Use skill_load when you know which skill you want. Use skill_search when you do not.",
		],
		parameters: Type.Object({
			names: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				maxItems: 5,
				description: "Exact skill names, as skill_search reported them.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const skills = await skillEntries(ctx?.cwd ?? process.cwd());
			if (!skills.length) {
				throw new Error("No enabled Agent Skills are available to load.");
			}

			const byName = new Map(skills.map((entry) => [entry.name, entry]));
			const allNames = skills.map((entry) => entry.name);
			const loaded: SkillEntry[] = [];
			const misses: { name: string; suggestions: string[] }[] = [];
			const seen = new Set<string>();

			for (const requested of params.names) {
				const name = requested.trim();
				const exact = byName.get(name);
				if (exact) {
					if (!seen.has(exact.name)) {
						seen.add(exact.name);
						loaded.push(exact);
					}
					continue;
				}
				const suggestions = suggestNames(name, allNames);
				// A single unambiguous case or separator slip is the same skill, so take it.
				if (suggestions.length === 1 && (suggestions[0]!.reason === "case" || suggestions[0]!.reason === "separator")) {
					const resolved = byName.get(suggestions[0]!.name)!;
					if (!seen.has(resolved.name)) {
						seen.add(resolved.name);
						loaded.push(resolved);
					}
					continue;
				}
				misses.push({ name, suggestions: suggestions.map((entry) => entry.name) });
			}

			const problems = misses.map(({ name, suggestions }) => {
				const hint = didYouMean(suggestions.map((s) => ({ name: s, reason: "typo" as const })));
				return hint
					? `No skill named '${name}'.${hint}`
					: `No skill named '${name}', and nothing close to it is enabled.`;
			});

			if (!loaded.length) {
				return {
					content: [
						{
							type: "text",
							text: `${problems.join(" ")} Call skill_load again with an exact name, or skill_search with a task description.`,
						},
					],
					details: { loaded: [], misses },
					isError: true,
				};
			}

			const bodies = loaded.map((skill) => renderSkill(skill, "Loaded by name, without ranking."));
			const note = problems.length ? `\n\n${problems.join(" ")}` : "";
			return {
				content: [
					{
						type: "text",
						text:
							`Loaded ${bodies.length} Agent Skill${bodies.length === 1 ? "" : "s"} by name. Follow these instructions for the current task:\n\n`
							+ bodies.join("\n\n") + note,
					},
				],
				details: { loaded: loaded.map((entry) => entry.name), misses },
			};
		},
	});

	pi.registerTool({
		name: "skill_search",
		label: "Skill Search",
		description:
			"Rate every enabled Agent Skill against the current task with Jev and load the full instructions of the ones that actually apply. Describe the task in plain language; do not guess skill names.",
		promptSnippet: "Find and load the Agent Skills that apply to the current task",
		promptGuidelines: [
			"The Agent Skills catalog is intentionally omitted from this prompt. Before substantive work where a specialized workflow, private CLI or house convention may exist, call skill_search once with a plain-language description of the task. It returns the complete instructions of any skill that applies, or says that none do.",
		],
		parameters: Type.Object({
			task: Type.String({
				minLength: 3,
				description:
					"Plain-language description of what you are about to do, including the concrete tools, services or files involved. For example: 'restart the jellyfin service on the server-pc box and tail its logs'.",
			}),
			maxSkills: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5,
					description: "Maximum skills to load (default 3).",
				}),
			),

		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const skills = await skillEntries(ctx?.cwd ?? process.cwd());
			if (!skills.length) {
				throw new Error("No enabled Agent Skills are available to search.");
			}

			// The default config reader is what we want; only the harness's own
			// agent directory differs between Pi and omp.
			const config = loadConfig(process.env, undefined, runtime);
			const limit = params.maxSkills ?? config.maxSkills;

			const task = params.task.trim();

			onUpdate?.({
				content: [{ type: "text", text: `Rating ${skills.length} enabled skills against the task…` }],
				details: { status: "running", transport: config.transport, totalSkills: skills.length },
			});

			let result: Awaited<ReturnType<typeof rankSkills>>;
			try {
				result = await rankSkills(task, skills, config, limit, signal);
			} catch (error) {
				if (signal?.aborted) throw error;
				if (!(error instanceof JevError)) throw error;

				const matches = lexicalMatches(skills, task, limit);
				const reason = `Jev was unreachable (${error.message})`;
				if (!matches.length) {
					return {
						content: [
							{
								type: "text",
								text: `${reason}. The deterministic lexical fallback matched no skills either. Continue with ordinary tools and reasoning.`,
							},
						],
						details: { task, fallback: "lexical", error: error.message, matches: [] },
					};
				}

				const rendered = matches
					.map(({ skill }, index) => `${index + 1}. ${skill.name}\n   ${skill.description.slice(0, 400)}\n   Read: ${skill.filePath}`)
					.join("\n\n");
				return {
					content: [
						{
							type: "text",
							text:
								`${reason}, so these are lexical keyword matches rather than Jev judgments. Read a SKILL.md before following it.\n\n${rendered}`,
						},
					],
					details: {
						task,
						fallback: "lexical",
						error: error.message,
						matches: matches.map(({ skill, score }) => ({ name: skill.name, filePath: skill.filePath, score })),
					},
				};
			}

			const details = {
				task,
				model: result.model ?? config.model,
				transport: config.transport,
				transports: result.transports,
				fallbacks: result.fallbacks,
				totalSkills: skills.length,
				shards: result.shards,
				inputTokens: result.inputTokens,
				classifications: result.classifications,
				minScore: config.minScore,
				partialFailures: result.failures,
				selections: result.ranked.map(({ skill, score, confidence }) => ({
					name: skill.name,
					filePath: skill.filePath,
					score,
					confidence,
				})),
				alsoRanked: result.alsoRanked.map(({ skill, score }) => ({ name: skill.name, score })),
			};

			const partial = result.failures.length
				? ` ${result.failures.length} of ${result.shards} shards failed, so part of the catalog went unrated.`
				: "";
			const diverted = result.fallbacks
				? ` ${result.fallbacks} of ${result.shards} shards were answered by the other service after ${transportLabel(config.transport)} failed.`
				: "";

			if (!result.ranked.length) {
				return {
					content: [
						{
							type: "text",
							text: `No enabled Agent Skill scored at or above ${config.minScore} of 2 for this task.${partial}${diverted} Continue with ordinary tools and reasoning.`,
						},
					],
					details,
				};
			}

			const loaded = result.ranked.map(({ skill, score, confidence }) =>
				renderSkill(skill, `Jev rated this ${score.toFixed(2)} of 2 for the stated task (confidence ${confidence.toFixed(2)}).`),
			);
			// Everything else above the floor, so the agent can pull one in deliberately.
			const alsoText = result.alsoRanked.length
				? `\n\nThese also scored above ${config.minScore} but were not loaded. Use skill_load to pull one in:\n`
					+ result.alsoRanked
						.map(({ skill, score }) => `- ${skill.name} (${score.toFixed(2)}) — ${skill.filePath}`)
						.join("\n")
				: "";
			return {
				content: [
					{
						type: "text",
						text:
							`Jev selected and loaded ${loaded.length} Agent Skill${loaded.length === 1 ? "" : "s"} out of ${skills.length} enabled.${partial}${diverted} Follow these instructions for the current task:\n\n`
							+ loaded.join("\n\n") + alsoText,
					},
				],
				details,
			};
		},
	});
}
