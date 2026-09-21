/**
 * Pure core for pi-jev-skill-picker: configuration, request construction for
 * both ranking transports, response ranking, and a deterministic lexical fallback.
 *
 * Jev is reachable two ways. TypeSafe's own System One endpoint answers typed
 * Score questions and needs a key. classifier.dev runs the same model behind a
 * label API, needs no key, and is the default when none is configured.
 *
 * Nothing here touches Pi. Everything here is unit-testable.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** classifier.dev, the keyless route to Jev. */
export const CLASSIFIER_ENDPOINT = "https://classifier.dev/v1/classify";
/** TypeSafe's System One endpoint, the keyed route to Jev. */
export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const DEFAULT_MODEL = "jev-latest";
export const DEFAULT_SHARD_SIZE = 50;
export const DEFAULT_MAX_SKILLS = 3;
export const DEFAULT_MIN_SCORE = 1.4;
export const DEFAULT_DESCRIPTION_LIMIT = 1200;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_FALLBACK = true;
/** How much of the task is embedded in a classifier.dev criteria block. */
export const TASK_LIMIT = 1200;

/**
 * Pi wraps the generated catalog in <skills>...</skills>. Older builds emitted the
 * bare header plus <available_skills>, and omp (oh-my-pi) renders its own heading
 * above the same block, so every shape is handled.
 */
const CATALOG_OPEN = "<skills>";
const CATALOG_CLOSE = "</skills>";
const LEGACY_START = "\n\nThe following skills provide specialized instructions for specific tasks.";
const LEGACY_END = "</available_skills>";
/** A heading that names skills, however omp words it. */
const OMP_SKILLS_HEADING = /^#+.*\bskills?\b/i;
/** omp's pointer line telling the model to read `skill://<name>` first. */
const OMP_SKILLS_POINTER = /^Matching skill[^\n]*skill:\/\/[^\n]*/;

/**
 * omp does not carry an extension's promptGuidelines into the prompt, so the
 * instruction to reach for skill_search has to travel in the prompt itself. It
 * replaces the catalog at the spot the model already looked for skills.
 */
export const OMP_SKILLS_GUIDANCE = [
	"# Skills & Rules",
	"The Agent Skills catalog is intentionally left out of this prompt. Before substantive work where a specialized workflow, private CLI or house convention may exist, call the `skill_search` tool once with a plain-language description of the task and follow the instructions it loads. Use `skill_load` for a skill you already know by name.",
].join("\n");

/** The ordered Score levels every skill is judged against. */
export const RELEVANCE_LEVELS = [
	"Unrelated. The skill covers a different domain, tool, service or workflow than the task. Loading its instructions would only waste the agent's attention.",
	"Adjacent. The skill sits in the same general area as the task, but does not cover the specific tool, service or step the task actually needs.",
	"Directly applicable. The skill covers the exact tool, service, workflow or domain the task needs, and following its instructions would change how the task is carried out.",
];

/** classifier.dev answers with one of these instead of a Score question. */
export const CLASSIFIER_LABELS = ["unrelated", "adjacent", "applicable"] as const;

/** Which service answers the Score questions. */
export type Transport = "classifier" | "typesafe";

/** Which harness is running the extension. The two differ in prompt shape and config dir. */
export type Runtime = "pi" | "omp";

export interface SkillEntry {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export interface JevConfig {
	apiKey?: string;
	classifyApiKey?: string;
	transport: Transport;
	fallback: boolean;
	model: string;
	shardSize: number;
	minScore: number;
	maxSkills: number;
	descriptionLimit: number;
	timeoutMs: number;
	endpoint: string;
	/** Resolved config file path, only for messages that tell the user where to put a key. */
	configFile: string;
}

export interface ScoreAnswer {
	type?: string;
	score?: number;
	confidence?: number;
}

export interface SystemOneResponse {
	model?: string;
	answers?: Record<string, ScoreAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ClassifierResult {
	label?: string;
	confidence?: number | null;
	scores?: Record<string, number> | null;
}

export interface ClassifierResponse {
	model?: string;
	tier?: string;
	results?: ClassifierResult[];
	usage?: { classifications?: number; escalated?: number };
}

export interface Ranked {
	skill: SkillEntry;
	score: number;
	confidence: number;
}

/** Strip Pi's generated `<skills>` catalog from a system prompt. */
export function stripSkillCatalog(systemPrompt: string): string {
	const open = systemPrompt.indexOf(CATALOG_OPEN);
	if (open !== -1) {
		const close = systemPrompt.indexOf(CATALOG_CLOSE, open);
		if (close !== -1) {
			// Swallow one preceding blank line so the surrounding prompt stays tidy.
			const start = systemPrompt.slice(0, open).endsWith("\n\n") ? open - 1 : open;
			return systemPrompt.slice(0, start) + systemPrompt.slice(close + CATALOG_CLOSE.length);
		}
	}

	const legacyStart = systemPrompt.indexOf(LEGACY_START);
	if (legacyStart === -1) return systemPrompt;
	const legacyEnd = systemPrompt.indexOf(LEGACY_END, legacyStart);
	if (legacyEnd === -1) return systemPrompt;
	return systemPrompt.slice(0, legacyStart) + systemPrompt.slice(legacyEnd + LEGACY_END.length);
}

/**
 * omp renders a heading and a `skill://` pointer above the catalog. The whole
 * section goes out as one piece — any skills heading directly above the block, the
 * pointer line, and the block itself — so no half of it survives a reworded
 * heading upstream, and the replacement lands exactly where the model used to be
 * told about skills.
 */
function rewriteOmpSkillSection(part: string, replacement: string): string {
	if (!part.includes(CATALOG_OPEN)) return part;
	const open = part.indexOf(CATALOG_OPEN);
	const close = part.indexOf(CATALOG_CLOSE, open);
	// A truncated section belongs to the caller's join pass, not to this one.
	if (close === -1) return part;

	// Walk back over the section's own lines, stopping at anything that is not a
	// skills heading or the pointer, so unrelated prompt text above it stays put.
	// Each line keeps its own line ending, so the cut lands exactly where it should.
	const prefix = part.slice(0, open);
	const lines = prefix.slice(0, prefix.length - (/(?:\r?\n)*$/.exec(prefix)?.[0].length ?? 0)).split(/(?<=\r?\n)/);
	let first = lines.length;
	while (first > 0 && (OMP_SKILLS_HEADING.test(lines[first - 1]!) || OMP_SKILLS_POINTER.test(lines[first - 1]!))) first--;
	const start = first === lines.length ? open : lines.slice(0, first).join("").length;

	const end = close + CATALOG_CLOSE.length;
	// The line break that closed the block goes with it, so it leaves no gap.
	const rest = part.slice(end);
	const newline = /^\r?\n/.exec(rest);
	const tail = newline ? rest.slice(newline[0].length) : rest;
	return part.slice(0, start) + (replacement ? `${replacement}${part.includes("\r\n") ? "\r\n" : "\n"}` : "") + tail;
}

/**
 * omp hands the system prompt over as an array of parts. Rewrite the catalog in
 * the part that holds it; if the block straddles parts, join, rewrite and return
 * one part. A `replacement` takes the section's place instead of leaving a hole.
 */
export function stripSkillCatalogParts(parts: string[], replacement = ""): string[] {
	const rewritten = parts.map((part) => rewriteOmpSkillSection(part, replacement));
	if (rewritten.some((part) => part.includes(CATALOG_OPEN))) {
		return [rewriteOmpSkillSection(parts.join("\n\n"), replacement)];
	}
	return rewritten;
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function finiteNumber(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) ? parsed : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function trimmed(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The agent directory of the running harness. Both honor PI_CODING_AGENT_DIR. */
export function agentDir(runtime: Runtime = "pi", env: NodeJS.ProcessEnv = process.env): string {
	const override = trimmed(env.PI_CODING_AGENT_DIR);
	if (override) return override;
	if (runtime === "omp") {
		// omp keeps a named profile's agent directory beside the default one, and
		// lets PI_CONFIG_DIR move the root itself.
		const root = join(homedir(), trimmed(env.PI_CONFIG_DIR) ?? ".omp");
		const profile = trimmed(env.OMP_PROFILE) ?? trimmed(env.PI_PROFILE);
		return profile ? join(root, "profiles", profile, "agent") : join(root, "agent");
	}
	return join(homedir(), ".pi", "agent");
}

export function configPath(env: NodeJS.ProcessEnv = process.env, runtime: Runtime = "pi"): string {
	return trimmed(env.PI_SKILL_JEV_CONFIG) ?? join(agentDir(runtime, env), "skill-jev.json");
}

function parseTransport(value: unknown): Transport | undefined {
	const normalized = trimmed(value)?.toLowerCase();
	return normalized === "classifier" || normalized === "typesafe" ? normalized : undefined;
}

/** The service an endpoint URL names, when its host is one of the two we know. */
function endpointTransport(endpoint: string | undefined): Transport | undefined {
	if (!endpoint) return undefined;
	let host: string;
	try {
		host = new URL(endpoint).hostname.toLowerCase();
	} catch {
		return undefined;
	}
	// A hostname suffix match, so `fakeclassifier.dev` is not mistaken for the service.
	if (host === "api.typesafe.ai" || host.endsWith(".typesafe.ai")) return "typesafe";
	if (host === "classifier.dev" || host.endsWith(".classifier.dev")) return "classifier";
	return undefined;
}

const DEFAULT_ENDPOINTS: Record<Transport, string> = {
	classifier: CLASSIFIER_ENDPOINT,
	typesafe: TYPESAFE_ENDPOINT,
};

/**
 * Which service to ask. An explicit `transport` wins, so a classifier.dev-shaped
 * proxy can live at any URL. Otherwise a known endpoint host decides; failing
 * that, a TypeSafe key is the signal that direct, keyed Jev is available.
 */
export function resolveTransport(options: {
	transport?: unknown;
	endpoint?: unknown;
	apiKey?: string;
}): Transport {
	const explicit = parseTransport(options.transport);
	if (explicit) return explicit;
	const named = endpointTransport(trimmed(options.endpoint));
	if (named) return named;
	return options.apiKey ? "typesafe" : "classifier";
}

/**
 * The URL a given service is asked at. A configured endpoint belongs to the
 * service it names: asking the other service's request shape there would only
 * earn a 400, and the credentials in hand belong to the service the endpoint
 * names, never to the other one. An endpoint on an unknown host is a proxy, and
 * it serves the transport it was configured for.
 */
function endpointFor(config: JevConfig, transport: Transport): string {
	const named = endpointTransport(config.endpoint);
	if (named) return named === transport ? config.endpoint : DEFAULT_ENDPOINTS[transport];
	return transport === config.transport ? config.endpoint : DEFAULT_ENDPOINTS[transport];
}

/**
 * Resolve configuration. Environment variables win over the JSON config file,
 * which wins over the package defaults. The API key is never read from argv.
 */
export function loadConfig(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
	runtime: Runtime = "pi",
): JevConfig {
	let file: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(readFile(configPath(env, runtime))) as unknown;
		if (parsed && typeof parsed === "object") file = parsed as Record<string, unknown>;
	} catch {
		// A missing or malformed config file falls back to environment and defaults.
	}

	const apiKey = trimmed(env.TYPESAFE_API_KEY) ?? trimmed(file.apiKey);
	const endpoint = trimmed(env.PI_SKILL_JEV_ENDPOINT) ?? trimmed(file.endpoint);
	const transport = resolveTransport({
		transport: env.PI_SKILL_JEV_TRANSPORT ?? file.transport,
		endpoint,
		apiKey,
	});

	return {
		apiKey,
		classifyApiKey:
			trimmed(env.CLASSIFY_API_KEY)
			?? trimmed(env.CLASSIFIER_API_KEY)
			?? trimmed(file.classifyApiKey),
		transport,
		// A blank environment variable is treated as unset, so it cannot shadow a
		// value the config file did set.
		fallback: boolean(trimmed(env.PI_SKILL_JEV_FALLBACK) ?? file.fallback, DEFAULT_FALLBACK),
		model: trimmed(env.PI_SKILL_JEV_MODEL) ?? trimmed(file.model) ?? DEFAULT_MODEL,
		shardSize: positiveInteger(trimmed(env.PI_SKILL_JEV_SHARD_SIZE) ?? file.shardSize, DEFAULT_SHARD_SIZE),
		minScore: finiteNumber(trimmed(env.PI_SKILL_JEV_MIN_SCORE) ?? file.minScore, DEFAULT_MIN_SCORE),
		maxSkills: positiveInteger(trimmed(env.PI_SKILL_JEV_MAX_SKILLS) ?? file.maxSkills, DEFAULT_MAX_SKILLS),
		descriptionLimit: positiveInteger(file.descriptionLimit, DEFAULT_DESCRIPTION_LIMIT),
		timeoutMs: positiveInteger(trimmed(env.PI_SKILL_JEV_TIMEOUT_MS) ?? file.timeoutMs, DEFAULT_TIMEOUT_MS),
		endpoint: endpoint ?? DEFAULT_ENDPOINTS[transport],
		configFile: configPath(env, runtime),
	};
}

export function shorten(value: string, maximum: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= maximum ? collapsed : `${collapsed.slice(0, maximum - 1).trimEnd()}…`;
}

/**
 * Split into evenly sized shards. `size` is a target maximum, not a fixed chunk:
 * the shard count comes from it, then items are spread evenly across that many
 * shards. Latency tracks the largest shard, so a lopsided tail (100+37) costs
 * far more than the same work split evenly (69+68).
 */
export function shard<T>(items: T[], size: number): T[][] {
	if (items.length === 0) return [];
	const count = Math.max(1, Math.ceil(items.length / Math.max(1, size)));
	const base = Math.floor(items.length / count);
	const remainder = items.length % count;
	const shards: T[][] = [];
	let index = 0;
	for (let n = 0; n < count; n++) {
		const take = base + (n < remainder ? 1 : 0);
		shards.push(items.slice(index, index + take));
		index += take;
	}
	return shards;
}

/** Question id for a skill's position in the full catalog. Ids never reach the model. */
export function questionId(index: number): string {
	return `skill_${index}`;
}

/**
 * One Score question per skill. The task lives in the shared state; each skill's
 * identity lives in its own question, so a large catalog never rots the state.
 */
export function buildQuestions(
	skills: SkillEntry[],
	offset: number,
	descriptionLimit: number,
): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const [position, skill] of skills.entries()) {
		questions[questionId(offset + position)] = {
			type: "score",
			instructions: {
				judgement:
					"Rate how useful this one Agent Skill would be to an autonomous coding agent working on the task described in `task`. Judge only this skill; other skills are rated separately.",
				skill_name: skill.name,
				skill_description: shorten(skill.description, descriptionLimit),
			},
			criteria: RELEVANCE_LEVELS,
		};
	}
	return questions;
}

export function buildTypeSafeRequest(
	task: string,
	skills: SkillEntry[],
	offset: number,
	config: JevConfig,
): Record<string, unknown> {
	return {
		model: config.model,
		state: { task: task.trim() },
		questions: buildQuestions(skills, offset, config.descriptionLimit),
	};
}

/**
 * classifier.dev takes one text per skill and a shared criteria block. The levels
 * keep their wording, with the label names standing in for the Score criteria.
 */
export function buildClassifierRequest(
	task: string,
	skills: SkillEntry[],
	config: JevConfig,
): Record<string, unknown> {
	const criteria = RELEVANCE_LEVELS
		.map((level, index) => `${CLASSIFIER_LABELS[index]}: ${level}`)
		.join("\n");

	return {
		// No `model`: the service answers with Jev unless asked for Laya, and a
		// TypeSafe model name like jev-latest is a 400 there.
		inputs: skills.map((skill) => `${skill.name}: ${shorten(skill.description, config.descriptionLimit)}`),
		labels: [...CLASSIFIER_LABELS],
		instructions: [
			"Rate the single Agent Skill described by each input for an autonomous coding agent working on the task below. Answer with the one label that fits best.",
			criteria,
			`Task: ${shorten(task.trim(), TASK_LIMIT)}`,
		].join("\n\n"),
	};
}

/**
 * classifier.dev answers in input order with a calibrated probability per label,
 * so a level position comes from the score distribution rather than a per-question
 * Score field. Nulls mean the answer was escalated and has no comparable
 * probabilities, and are left unrated instead of guessed at.
 */
export function rankClassifierResults(
	response: ClassifierResponse,
	skills: SkillEntry[],
	offset: number,
): Record<string, ScoreAnswer> {
	const results = response.results;
	if (!Array.isArray(results) || results.length !== skills.length) {
		throw new JevError(
			`classifier.dev answered ${Array.isArray(results) ? results.length : 0} results for ${skills.length} skills, so the scores cannot be lined up.`,
		);
	}

	const answers: Record<string, ScoreAnswer> = {};
	for (const [position, result] of results.entries()) {
		const scores = result?.scores;
		if (!scores || typeof scores !== "object") continue;

		let weighted = 0;
		let total = 0;
		for (const [level, label] of CLASSIFIER_LABELS.entries()) {
			const probability = scores[label];
			if (typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0) continue;
			weighted += probability * level;
			total += probability;
		}
		if (total <= 0) continue;

		// Scores can be rounded to two decimals, so normalise rather than trust a sum of 1.
		answers[questionId(offset + position)] = {
			type: "score",
			score: weighted / total,
			confidence: typeof result.confidence === "number" && Number.isFinite(result.confidence) ? result.confidence : 0,
		};
	}
	return answers;
}

/** Map Jev answers back onto the catalog, keeping only scores at or above the floor. */
export function rank(
	skills: SkillEntry[],
	answers: Record<string, ScoreAnswer>,
	minScore: number,
): Ranked[] {
	const ranked: Ranked[] = [];
	for (const [index, skill] of skills.entries()) {
		const answer = answers[questionId(index)];
		if (!answer || typeof answer.score !== "number" || !Number.isFinite(answer.score)) continue;
		if (answer.score < minScore) continue;
		ranked.push({
			skill,
			score: answer.score,
			confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
		});
	}
	ranked.sort(
		(left, right) =>
			right.score - left.score
			|| right.confidence - left.confidence
			|| left.skill.name.localeCompare(right.skill.name),
	);
	return ranked;
}

export class JevError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "JevError";
		this.status = status;
	}
}

const RETRYABLE = new Set([429, 500, 502, 503, 529]);

/** A 429 can name a wait of hours; a tool call cannot sit on one. */
export const MAX_RETRY_DELAY_MS = 10_000;

/**
 * How long to wait before retrying. A service that names its own wait is
 * believed up to the cap, so a daily-limit 429 does not park every shard.
 */
export function retryDelayMs(retryAfterSeconds: number | undefined, attempt: number): number {
	const named = Number.isFinite(retryAfterSeconds) ? (retryAfterSeconds as number) * 1000 : undefined;
	return Math.max(0, Math.min(named ?? 250 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		function abort() {
			clearTimeout(timer);
			reject(new JevError("Skill ranking was cancelled."));
		}
		if (signal?.aborted) return abort();
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** One POST, with backoff on the documented retryable statuses. */
async function postJson(
	url: string,
	body: Record<string, unknown>,
	headers: Record<string, string>,
	label: string,
	config: JevConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	attempts = 3,
): Promise<unknown> {
	let lastError: JevError | undefined;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: composed,
			});
		} catch (error) {
			if (signal?.aborted) throw new JevError("Skill ranking was cancelled.");
			lastError = new JevError(`Request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
			if (attempt === attempts) break;
			await sleep(retryDelayMs(undefined, attempt), signal);
			continue;
		}

		if (response.ok) {
			const parsed = (await response.json().catch(() => undefined)) as unknown;
			// A body that is not an object is no answer to rank against.
			if (!parsed || typeof parsed !== "object") {
				throw new JevError(`${label} answered ${response.status} with a body that is not a JSON object.`, response.status);
			}
			return parsed;
		}

		const detail = shorten(await response.text().catch(() => ""), 300);
		lastError = new JevError(`${label} returned ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
		if (!RETRYABLE.has(response.status) || attempt === attempts) break;
		const retryAfter = Number.parseFloat(response.headers.get("retry-after") ?? "");
		await sleep(retryDelayMs(Number.isFinite(retryAfter) ? retryAfter : undefined, attempt), signal);
	}

	throw lastError ?? new JevError(`${label} request failed for an unknown reason.`);
}

interface ShardAnswer {
	answers: Record<string, ScoreAnswer>;
	model?: string;
	inputTokens: number;
	classifications: number;
	transport: Transport;
}

async function askTypeSafe(
	task: string,
	skills: SkillEntry[],
	offset: number,
	config: JevConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ShardAnswer> {
	if (!config.apiKey) {
		throw new JevError(
			"No TypeSafe API key. Set TYPESAFE_API_KEY, or add \"apiKey\" to " + config.configFile + ".",
		);
	}

	const response = (await postJson(
		endpointFor(config, "typesafe"),
		buildTypeSafeRequest(task, skills, offset, config),
		{ Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
		"TypeSafe",
		config,
		signal,
		fetchImpl,
	)) as SystemOneResponse;

	return {
		answers: response.answers ?? {},
		model: typeof response.model === "string" ? response.model : undefined,
		inputTokens: response.usage?.input_tokens ?? 0,
		classifications: 0,
		transport: "typesafe",
	};
}

async function askClassifier(
	task: string,
	skills: SkillEntry[],
	offset: number,
	config: JevConfig,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ShardAnswer> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	// Only classifier.dev's own key ever goes here; the TypeSafe key stays with TypeSafe.
	if (config.classifyApiKey) headers.Authorization = `Bearer ${config.classifyApiKey}`;

	const response = (await postJson(
		endpointFor(config, "classifier"),
		buildClassifierRequest(task, skills, config),
		headers,
		"classifier.dev",
		config,
		signal,
		fetchImpl,
	)) as ClassifierResponse;

	return {
		answers: rankClassifierResults(response, skills, offset),
		model: typeof response.model === "string" ? response.model : undefined,
		inputTokens: 0,
		classifications: typeof response.usage?.classifications === "number" ? response.usage.classifications : 0,
		transport: "classifier",
	};
}

async function askShard(
	task: string,
	skills: SkillEntry[],
	offset: number,
	config: JevConfig,
	transport: Transport,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ShardAnswer> {
	return transport === "classifier"
		? askClassifier(task, skills, offset, config, signal, fetchImpl)
		: askTypeSafe(task, skills, offset, config, signal, fetchImpl);
}

export interface RankSkillsResult {
	ranked: Ranked[];
	alsoRanked: Ranked[];
	model?: string;
	inputTokens: number;
	classifications: number;
	shards: number;
	failures: string[];
	/** Which services actually answered, in the order they were tried. */
	transports: Transport[];
	/** Shards that only ranked because the other service took over. */
	fallbacks: number;
}

/** The other service, when it can actually be asked. */
function backupTransport(config: JevConfig): Transport | undefined {
	// TypeSafe needs a key and a key is what makes the other route reachable, so a
	// keyless setup has nothing to divert to. A pinned transport with no key is a
	// configuration mistake and is reported rather than quietly worked around.
	if (!config.fallback || !config.apiKey) return undefined;
	return config.transport === "classifier" ? "typesafe" : "classifier";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const TRANSPORT_LABELS: Record<Transport, string> = {
	classifier: "classifier.dev",
	typesafe: "TypeSafe",
};

/** What to call a service in a message a person reads. */
export function transportLabel(transport: Transport): string {
	return TRANSPORT_LABELS[transport];
}

/** Rank the whole catalog by firing every shard in parallel. */
export async function rankSkills(
	task: string,
	skills: SkillEntry[],
	config: JevConfig,
	limit: number,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<RankSkillsResult> {
	const shards = shard(skills, config.shardSize);
	// Offsets must follow the actual shard lengths. Shards are balanced, so they
	// are not multiples of shardSize, and index * shardSize would map answers
	// onto the wrong skills.
	const offsets: number[] = [];
	let running = 0;
	for (const batch of shards) {
		offsets.push(running);
		running += batch.length;
	}

	const backup = backupTransport(config);
	const results = await Promise.all(
		shards.map(async (batch, index) => {
			const offset = offsets[index]!;
			try {
				return { answer: await askShard(task, batch, offset, config, config.transport, signal, fetchImpl), fellBack: false, error: undefined };
			} catch (error) {
				if (signal?.aborted) throw error;
				const primaryError = `${TRANSPORT_LABELS[config.transport]}: ${errorMessage(error)}`;
				if (!backup) return { answer: undefined, fellBack: false, error: primaryError };
				try {
					return { answer: await askShard(task, batch, offset, config, backup, signal, fetchImpl), fellBack: true, error: undefined };
				} catch (fallbackError) {
					if (signal?.aborted) throw fallbackError;
					return {
						answer: undefined,
						fellBack: false,
						error: `${primaryError}; ${TRANSPORT_LABELS[backup]} fallback also failed: ${errorMessage(fallbackError)}`,
					};
				}
			}
		}),
	);

	const answers: Record<string, ScoreAnswer> = {};
	const failures: string[] = [];
	const transports: Transport[] = [];
	let model: string | undefined;
	let inputTokens = 0;
	let classifications = 0;
	let fallbacks = 0;
	for (const result of results) {
		if (result.error) {
			failures.push(result.error);
			continue;
		}
		const answer = result.answer!;
		model ??= answer.model;
		inputTokens += answer.inputTokens;
		classifications += answer.classifications;
		if (result.fellBack) fallbacks++;
		transports.push(answer.transport);
		for (const [id, scored] of Object.entries(answer.answers)) answers[id] = scored;
	}

	if (failures.length === shards.length && shards.length > 0) {
		throw new JevError(`Every Jev request failed. ${failures[0]}`);
	}

	const scored = rank(skills, answers, config.minScore);
	return {
		ranked: scored.slice(0, limit),
		// Cleared the floor but lost on score. Reported so the agent can force-load one.
		alsoRanked: scored.slice(limit),
		model,
		inputTokens,
		classifications,
		shards: shards.length,
		failures,
		transports: [...new Set(transports)],
		fallbacks,
	};
}
