import assert from "node:assert/strict";
import { test } from "node:test";

import {
	agentDir,
	buildClassifierRequest,
	buildQuestions,
	buildTypeSafeRequest,
	configPath,
	CLASSIFIER_ENDPOINT,
	loadConfig,
	MAX_RETRY_DELAY_MS,
	questionId,
	rank,
	rankClassifierResults,
	rankSkills,
	resolveTransport,
	retryDelayMs,
	shard,
	shorten,
	stripSkillCatalog,
	stripSkillCatalogParts,
	TYPESAFE_ENDPOINT,
	CLASSIFIER_LABELS,
	DEFAULT_MODEL,
	RELEVANCE_LEVELS,
	type JevConfig,
	type SkillEntry,
} from "../extensions/jev.ts";
import { lexicalMatches, queryTerms } from "../extensions/lexical.ts";

function skill(name: string, description: string): SkillEntry {
	return { name, description, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` };
}

/** Keyless: classifier.dev answers. */
function classifierConfig(overrides: Partial<JevConfig> = {}): JevConfig {
	return { ...loadConfig({}, () => "{}"), ...overrides };
}

/** A TypeSafe key is what puts TypeSafe first. */
function typesafeConfig(overrides: Partial<JevConfig> = {}): JevConfig {
	return { ...loadConfig({ TYPESAFE_API_KEY: "key" }, () => "{}"), ...overrides };
}

/** The shape Pi 0.86 actually emits, captured from a live system prompt. */
const CATALOG = [
	"You are Pi.",
	"",
	"<skills>",
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches.",
	"<available_skills>",
	"  <skill>",
	"    <name>fleet</name>",
	"    <description>Run commands on remote hosts</description>",
	"  </skill>",
	"</available_skills>",
	"</skills>",
	"",
	"<cwd>",
	"/tmp",
	"</cwd>",
].join("\n");

/** Pre-<skills> builds emitted the bare header instead. */
const LEGACY_CATALOG = [
	"You are Pi.",
	"",
	"The following skills provide specialized instructions for specific tasks.",
	"<available_skills>",
	"<skill><name>fleet</name></skill>",
	"</available_skills>",
	"Tools follow.",
].join("\n");

/** What omp (oh-my-pi) renders: its own heading and skill:// pointer, then the same block. */
const OMP_CATALOG = [
	"§ Runtime",
	"# Skills & Rules",
	"Matching skill → MUST read `skill://<name>` first.",
	"<skills>",
	"- fleet: Run commands on remote hosts",
	"- qb: qBittorrent housekeeping",
	"</skills>",
	"",
	"<generic-rules>",
	"Rule one.",
	"</generic-rules>",
].join("\n");

test("stripSkillCatalog removes the <skills> block Pi actually emits", () => {
	const stripped = stripSkillCatalog(CATALOG);
	assert.ok(!stripped.includes("<skills>"));
	assert.ok(!stripped.includes("<available_skills>"));
	assert.ok(!stripped.includes("fleet"));
	assert.ok(stripped.startsWith("You are Pi."));
	assert.ok(stripped.includes("<cwd>"), "content after the catalog must survive");
});

test("stripSkillCatalog still handles the legacy bare-header shape", () => {
	const stripped = stripSkillCatalog(LEGACY_CATALOG);
	assert.ok(!stripped.includes("<available_skills>"));
	assert.ok(!stripped.includes("fleet"));
	assert.ok(stripped.endsWith("Tools follow."));
});

test("stripSkillCatalog is a no-op when no catalog is present", () => {
	assert.equal(stripSkillCatalog("You are Pi."), "You are Pi.");
});

test("stripSkillCatalog leaves the prompt alone when the closing tag is missing", () => {
	const truncated = LEGACY_CATALOG.slice(0, LEGACY_CATALOG.indexOf("</available_skills>"));
	assert.equal(stripSkillCatalog(truncated), truncated);
});

test("stripSkillCatalogParts drops the omp heading and skill:// pointer with the catalog", () => {
	const parts = [OMP_CATALOG, "Footer part."];
	const stripped = stripSkillCatalogParts(parts);
	assert.equal(stripped.length, 2);
	assert.ok(!stripped[0]!.includes("<skills>"), "the catalog must go");
	assert.ok(!stripped[0]!.includes("fleet"));
	assert.ok(!stripped[0]!.includes("# Skills & Rules"), "omp's heading must go with it");
	assert.ok(!stripped[0]!.includes("Matching skill"), "so must the skill:// pointer");
	assert.ok(stripped[0]!.includes("<generic-rules>"), "the rest of the section must survive");
	assert.equal(stripped[1], "Footer part.");
});

test("stripSkillCatalogParts puts guidance where the catalog was", () => {
	const parts = [OMP_CATALOG, "Footer part."];
	const stripped = stripSkillCatalogParts(parts, "# Skills & Rules\nCall `skill_search` first.");
	assert.ok(!stripped[0]!.includes("<skills>"));
	assert.ok(!stripped[0]!.includes("Matching skill"));
	assert.ok(stripped[0]!.includes("# Skills & Rules\nCall `skill_search` first."), "the pointer must replace the section");
	assert.ok(stripped[0]!.includes("<generic-rules>"), "the rest of the section must survive");
	assert.equal(stripped[0]!.includes("# Skills & Rules\nCall `skill_search` first.\n\n<generic-rules>"), true, "no double blank line");
});

test("stripSkillCatalogParts leaves prompts without a catalog untouched", () => {
	const parts = ["You are omp.", "Nothing to strip."];
	assert.deepEqual(stripSkillCatalogParts(parts), parts);
	assert.deepEqual(stripSkillCatalogParts(parts, "guidance"), parts);
});

test("stripSkillCatalogParts still reaches the tools when omp's wording drifts", () => {
	// The heading and pointer are reworded upstream; the replacement must still land
	// in their place rather than leaving with the block.
	const drifted = ["§ Runtime", "## Skills you can read", "<skills>", "- fleet: remote", "</skills>", "", "<generic-rules>", "Rule.", "</generic-rules>"].join("\n");
	const parts = stripSkillCatalogParts([drifted], "Call `skill_search`.");
	assert.ok(!parts[0]!.includes("<skills>"));
	assert.ok(!parts[0]!.includes("## Skills you can read"), "the section heading goes with the block");
	assert.ok(parts[0]!.includes("Call `skill_search`."), "the replacement must survive a rename");
	assert.ok(parts[0]!.includes("<generic-rules>"));
	assert.ok(parts[0]!.includes("§ Runtime"), "unrelated prompt text stays put");
});

test("stripSkillCatalogParts keeps a CRLF prompt on its own line endings", () => {
	const crlf = [
		"§ Runtime",
		"# Skills & Rules",
		"Matching skill → MUST read `skill://<name>` first.",
		"<skills>",
		"- fleet: remote",
		"</skills>",
		"",
		"<generic-rules>",
		"Rule.",
		"</generic-rules>",
	].join("\r\n");
	const [rewritten] = stripSkillCatalogParts([crlf], "Call `skill_search`.");
	assert.ok(!rewritten!.includes("<skills>"));
	assert.ok(!rewritten!.includes("# Skills & Rules"));
	assert.ok(rewritten!.startsWith("§ Runtime\r\n"), "the text above the section is untouched");
	assert.ok(
		rewritten!.includes("Call `skill_search`.\r\n\r\n<generic-rules>"),
		`the replacement should keep the prompt's own line endings: ${JSON.stringify(rewritten)}`,
	);
});

test("stripSkillCatalogParts leaves an unrelated heading above the block alone", () => {
	const part = ["# House rules", "Be terse.", "<skills>", "- fleet: remote", "</skills>"].join("\n");
	const [rewritten] = stripSkillCatalogParts([part], "Call `skill_search`.");
	assert.ok(rewritten!.startsWith("# House rules\nBe terse.\n"), `kept: ${JSON.stringify(rewritten)}`);
	assert.ok(rewritten!.includes("Call `skill_search`."));
	assert.ok(!rewritten!.includes("<skills>"));
});

test("retryDelayMs caps a service's own Retry-After", () => {
	// classifier.dev's daily-limit 429 can name an hours-long wait; a tool call is
	// not going to sit on it.
	assert.equal(retryDelayMs(3600, 1), MAX_RETRY_DELAY_MS);
	assert.equal(retryDelayMs(2, 1), 2000);
	assert.equal(retryDelayMs(0, 1), 0);
	assert.equal(retryDelayMs(-5, 1), 0);
	assert.equal(retryDelayMs(undefined, 1), 250);
	assert.equal(retryDelayMs(undefined, 2), 500);
	assert.equal(retryDelayMs(Number.NaN, 3), 1000);
});

test("stripSkillCatalogParts survives a catalog split across parts", () => {
	const parts = ["Header\n<skills>\n- fleet: remote", "</skills>\nTail"];
	const stripped = stripSkillCatalogParts(parts);
	assert.equal(stripped.length, 1);
	assert.ok(!stripped[0]!.includes("<skills>"));
	assert.ok(!stripped[0]!.includes("</skills>"));
	assert.ok(stripped[0]!.includes("Header"));
	assert.ok(stripped[0]!.includes("Tail"));
});

test("shard derives a count from the target size and balances the split", () => {
	assert.deepEqual(shard([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(shard([], 2), []);

	// 137 skills at a target of 50 must not become the lopsided 50+50+37.
	const many = Array.from({ length: 137 }, (_, i) => i);
	const sizes = shard(many, 50).map((s) => s.length);
	assert.deepEqual(sizes, [46, 46, 45]);
	assert.equal(sizes.reduce((a, b) => a + b, 0), 137);
	assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "shards differ by at most one item");

	// Nothing is dropped or duplicated.
	assert.deepEqual(shard(many, 50).flat(), many);
});

test("shorten collapses whitespace and appends an ellipsis past the limit", () => {
	assert.equal(shorten("a   b\n c", 50), "a b c");
	assert.equal(shorten("abcdef", 4), "abc…");
});

test("buildQuestions carries the skill in the question, never in the state", () => {
	const skills = [skill("fleet", "Run commands on remote hosts"), skill("qb", "qBittorrent")];
	const questions = buildQuestions(skills, 10, 1200);
	assert.deepEqual(Object.keys(questions), [questionId(10), questionId(11)]);

	const first = questions[questionId(10)] as {
		type: string;
		instructions: { skill_name: string; skill_description: string };
		criteria: string[];
	};
	assert.equal(first.type, "score");
	assert.equal(first.instructions.skill_name, "fleet");
	assert.equal(first.instructions.skill_description, "Run commands on remote hosts");
	assert.equal(first.criteria, RELEVANCE_LEVELS);
	assert.equal(first.criteria.length, 3);
});

test("buildQuestions truncates a long description to the configured limit", () => {
	const questions = buildQuestions([skill("bhav", "x".repeat(5000))], 0, 100);
	const only = questions[questionId(0)] as { instructions: { skill_description: string } };
	assert.equal(only.instructions.skill_description.length, 100);
});

test("buildTypeSafeRequest puts only the task in the state", () => {
	const request = buildTypeSafeRequest("  restart jellyfin  ", [skill("fleet", "remote")], 0, typesafeConfig());
	assert.deepEqual(request.state, { task: "restart jellyfin" });
	assert.equal(request.model, DEFAULT_MODEL);
});

test("buildClassifierRequest sends one input per skill, the levels as labels, and no model", () => {
	const skills = [skill("fleet", "Run commands on remote hosts"), skill("qb", "qBittorrent")];
	const request = buildClassifierRequest("restart jellyfin", skills, classifierConfig());

	assert.equal("model" in request, false, "classifier.dev rejects TypeSafe model names");
	assert.deepEqual(request.labels, [...CLASSIFIER_LABELS]);
	assert.deepEqual(request.inputs, ["fleet: Run commands on remote hosts", "qb: qBittorrent"]);

	const instructions = request.instructions as string;
	assert.ok(instructions.includes("restart jellyfin"), "the task must reach the service");
	for (const level of RELEVANCE_LEVELS) {
		assert.ok(instructions.includes(level), "every level definition must be sent");
	}
});

test("rankClassifierResults turns the label distribution into a level position", () => {
	const skills = [skill("fleet", ""), skill("qb", "")];
	const answers = rankClassifierResults(
		{
			results: [
				{ label: "applicable", confidence: 0.98, scores: { unrelated: 0.01, adjacent: 0, applicable: 0.99 } },
				{ label: "unrelated", confidence: 0.83, scores: { unrelated: 0.89, adjacent: 0.11, applicable: 0 } },
			],
		},
		skills,
		5,
	);

	assert.deepEqual(Object.keys(answers), [questionId(5), questionId(6)]);
	assert.ok(Math.abs(answers[questionId(5)]!.score! - 1.98) < 1e-9);
	assert.equal(answers[questionId(5)]!.confidence, 0.98);
	assert.ok(Math.abs(answers[questionId(6)]!.score! - 0.11) < 1e-9);
});

test("rankClassifierResults normalises scores that were rounded to two decimals", () => {
	const answers = rankClassifierResults(
		{ results: [{ confidence: 0.5, scores: { unrelated: 0.33, adjacent: 0.33, applicable: 0.33 } }] },
		[skill("a", "")],
		0,
	);
	assert.ok(Math.abs(answers[questionId(0)]!.score! - 1) < 1e-9, "an even split sits at the middle level");
});

test("rankClassifierResults leaves escalated and scoreless answers unrated", () => {
	const answers = rankClassifierResults(
		{ results: [{ label: "applicable", confidence: null, scores: null }, {}] },
		[skill("a", ""), skill("b", "")],
		0,
	);
	assert.deepEqual(answers, {});
});

test("rankClassifierResults refuses to line up a short response", () => {
	assert.throws(
		() => rankClassifierResults({ results: [{ scores: { applicable: 1 } }] }, [skill("a", ""), skill("b", "")], 0),
		/cannot be lined up/,
	);
});

test("rank orders by score and applies the floor", () => {
	const skills = [skill("a", ""), skill("b", ""), skill("c", ""), skill("d", "")];
	const ranked = rank(
		skills,
		{
			[questionId(0)]: { score: 0.4, confidence: 0.9 },
			[questionId(1)]: { score: 1.9, confidence: 0.8 },
			[questionId(2)]: { score: 1.2, confidence: 0.7 },
			[questionId(3)]: { score: 1.2, confidence: 0.95 },
		},
		1.0,
	);
	// rank keeps everything above the floor; the caller decides how many to load.
	assert.deepEqual(ranked.map((entry) => entry.skill.name), ["b", "d", "c"]);
});

test("rank skips missing and non-numeric answers", () => {
	const ranked = rank([skill("a", ""), skill("b", "")], { [questionId(1)]: { score: Number.NaN } }, 0);
	assert.deepEqual(ranked, []);
});

test("resolveTransport prefers an explicit transport, then the endpoint host, then the key", () => {
	assert.equal(resolveTransport({}), "classifier");
	assert.equal(resolveTransport({ apiKey: "k" }), "typesafe");
	assert.equal(resolveTransport({ transport: "typesafe" }), "typesafe");
	assert.equal(resolveTransport({ transport: "classifier", apiKey: "k" }), "classifier");
	assert.equal(resolveTransport({ endpoint: TYPESAFE_ENDPOINT }), "typesafe");
	assert.equal(resolveTransport({ endpoint: CLASSIFIER_ENDPOINT, apiKey: "k" }), "classifier");
	assert.equal(resolveTransport({ endpoint: "https://classifier.dev/v1/classify/batch" }), "classifier");
	assert.equal(resolveTransport({ endpoint: "https://api.typesafe.ai:443/v1/systemone" }), "typesafe");
	// A proxy endpoint under an unknown host keeps the key-based default.
	assert.equal(resolveTransport({ endpoint: "https://jev.example.com/v1/systemone", apiKey: "k" }), "typesafe");
	assert.equal(resolveTransport({ endpoint: "https://jev.example.com/v1/classify" }), "classifier");
	// Lookalike hosts are not either service, so they fall through to the key.
	assert.equal(resolveTransport({ endpoint: "https://fakeclassifier.dev/v1/classify", apiKey: "k" }), "typesafe");
	assert.equal(resolveTransport({ endpoint: "https://classifier.dev.evil.example/v1/classify", apiKey: "k" }), "typesafe");
	assert.equal(resolveTransport({ endpoint: "https://api.typesafe.ai.evil.example/v1/systemone" }), "classifier");
});

test("loadConfig defaults to classifier.dev with no key and to TypeSafe with one", () => {
	const keyless = loadConfig({}, () => { throw new Error("ENOENT"); });
	assert.equal(keyless.transport, "classifier");
	assert.equal(keyless.endpoint, CLASSIFIER_ENDPOINT);
	assert.equal(keyless.apiKey, undefined);
	assert.equal(keyless.configFile, configPath({}));

	const keyed = loadConfig({ TYPESAFE_API_KEY: "k" }, () => { throw new Error("ENOENT"); });
	assert.equal(keyed.transport, "typesafe");
	assert.equal(keyed.endpoint, TYPESAFE_ENDPOINT);
});

test("loadConfig prefers the environment over the config file", () => {
	const fromEnv = ["env", "wins"].join("-");
	const config = loadConfig(
		{ TYPESAFE_API_KEY: fromEnv, PI_SKILL_JEV_MIN_SCORE: "1.5" },
		() => JSON.stringify({ apiKey: "from-file", model: "jev-1.13.0", minScore: 0.2, shardSize: 7 }),
	);
	assert.equal(config.apiKey, fromEnv);
	assert.equal(config.model, "jev-1.13.0");
	assert.equal(config.minScore, 1.5);
	assert.equal(config.shardSize, 7);
	assert.equal(config.transport, "typesafe", "the environment key selects the keyed route");
});

test("loadConfig reads the classifier.dev key, transport, fallback and endpoint", () => {
	const config = loadConfig(
		{
			CLASSIFY_API_KEY: "classifier_key",
			PI_SKILL_JEV_TRANSPORT: "classifier",
			PI_SKILL_JEV_ENDPOINT: "https://jev.example.com/v1/classify",
			PI_SKILL_JEV_FALLBACK: "off",
		},
		() => "{}",
	);
	assert.equal(config.classifyApiKey, "classifier_key");
	assert.equal(config.transport, "classifier");
	assert.equal(config.endpoint, "https://jev.example.com/v1/classify");
	assert.equal(config.fallback, false);

	// The Pro key's other documented spelling, and the JSON field.
	assert.equal(loadConfig({ CLASSIFIER_API_KEY: "other" }, () => "{}").classifyApiKey, "other");
	assert.equal(loadConfig({}, () => JSON.stringify({ classifyApiKey: "json-key" })).classifyApiKey, "json-key");
	assert.equal(loadConfig({}, () => "{}").fallback, true);

	// A blank variable is unset, not a value: it must not shadow the file.
	const fromFile = () => JSON.stringify({ fallback: false, minScore: 1.9, shardSize: 4, timeoutMs: 5000 });
	const blanked = loadConfig(
		{ PI_SKILL_JEV_FALLBACK: "", PI_SKILL_JEV_MIN_SCORE: " ", PI_SKILL_JEV_SHARD_SIZE: "", PI_SKILL_JEV_TIMEOUT_MS: "" },
		fromFile,
	);
	assert.equal(blanked.fallback, false);
	assert.equal(blanked.minScore, 1.9);
	assert.equal(blanked.shardSize, 4);
	assert.equal(blanked.timeoutMs, 5000);
});

test("loadConfig falls back to defaults when the config file is unreadable", () => {
	const config = loadConfig({}, () => { throw new Error("ENOENT"); });
	assert.equal(config.apiKey, undefined);
	assert.equal(config.model, DEFAULT_MODEL);
	assert.equal(config.shardSize, 50);
});

test("configPath follows the running harness, its profile and PI_CODING_AGENT_DIR", () => {
	assert.ok(configPath({}, "pi").endsWith("/.pi/agent/skill-jev.json"));
	assert.ok(configPath({}, "omp").endsWith("/.omp/agent/skill-jev.json"));
	// omp's named profiles and config root.
	assert.ok(configPath({ OMP_PROFILE: "work" }, "omp").endsWith("/.omp/profiles/work/agent/skill-jev.json"));
	assert.ok(configPath({ PI_CONFIG_DIR: "custom-root" }, "omp").endsWith("/custom-root/agent/skill-jev.json"));
	assert.ok(agentDir("omp", { PI_CODING_AGENT_DIR: "/custom/agent" }).startsWith("/custom/agent"));
	assert.equal(configPath({ PI_SKILL_JEV_CONFIG: "/elsewhere/jev.json" }, "omp"), "/elsewhere/jev.json");
	assert.equal(loadConfig({}, () => "{}", "omp").configFile, configPath({}, "omp"));
});

test("rankSkills fans out across shards and merges the answers", async () => {
	const skills = Array.from({ length: 5 }, (_, index) => skill(`s${index}`, `description ${index}`));
	const config = typesafeConfig({ shardSize: 2, minScore: 1 });
	const seen: string[][] = [];

	const fakeFetch = (async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const ids = Object.keys(body.questions);
		seen.push(ids);
		const answers: Record<string, unknown> = {};
		for (const id of ids) answers[id] = { type: "score", score: 2, confidence: 0.9 };
		return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 100 } }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 3, undefined, fakeFetch);
	assert.equal(result.shards, 3);
	assert.equal(seen.length, 3);
	assert.equal(result.inputTokens, 300);
	assert.equal(result.model, "jev-1.13.0");
	assert.equal(result.ranked.length, 3);
	assert.deepEqual(result.failures, []);
	assert.deepEqual(result.transports, ["typesafe"]);
	assert.equal(result.fallbacks, 0);
});

test("rankSkills asks classifier.dev with labels and no auth when no key is configured", async () => {
	const skills = Array.from({ length: 5 }, (_, index) => skill(`s${index}`, `description ${index}`));
	const config = classifierConfig({ shardSize: 2 });
	const bodies: Record<string, unknown>[] = [];
	const headers: Record<string, string>[] = [];

	const fakeFetch = (async (url: string, init: RequestInit) => {
		assert.equal(String(url), CLASSIFIER_ENDPOINT);
		bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
		headers.push(init.headers as Record<string, string>);
		const inputs = (JSON.parse(String(init.body)) as { inputs: string[] }).inputs;
		const results = inputs.map(() => ({
			label: "applicable",
			confidence: 0.9,
			scores: { unrelated: 0, adjacent: 0.1, applicable: 0.9 },
		}));
		return new Response(JSON.stringify({ tier: "fast", model: "jev-1.13.0", results, usage: { classifications: results.length } }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 5, undefined, fakeFetch);
	assert.equal(bodies.length, 3);
	for (const body of bodies) {
		assert.equal("model" in body, false);
		assert.deepEqual(body.labels, [...CLASSIFIER_LABELS]);
	}
	for (const header of headers) assert.equal(header.Authorization, undefined, "the TypeSafe key must never go to classifier.dev");

	// 1 * 0.1 + 2 * 0.9 = 1.9 for every skill, all above the 1.4 floor.
	assert.equal(result.ranked.length, 5);
	assert.equal(result.classifications, 5);
	assert.equal(result.inputTokens, 0);
	assert.equal(result.model, "jev-1.13.0");
	assert.deepEqual(result.transports, ["classifier"]);
});

test("rankSkills sends the classifier.dev Pro key when it is configured", async () => {
	const config = classifierConfig({ classifyApiKey: "classifier_pro_key" });
	let authorization: string | undefined;
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		authorization = (init.headers as Record<string, string>).Authorization;
		return new Response(JSON.stringify({ results: [{ scores: { applicable: 1 } }] }), { status: 200 });
	}) as unknown as typeof fetch;

	await rankSkills("a task", [skill("a", "")], config, 1, undefined, fakeFetch);
	assert.equal(authorization, "Bearer classifier_pro_key");
});

test("rankSkills maps classifier answers to the right skills when shards are uneven", async () => {
	// 7 skills at a target of 3 balances to 3+2+2, so offsets are 0,3,5 — never
	// multiples of the target. Each input is scored by its own position in the
	// catalog so any misalignment shows up as the wrong names coming back.
	const skills = Array.from({ length: 7 }, (_, i) => skill(`s${i}`, ""));
	const config = classifierConfig({ shardSize: 3, minScore: 0 });
	const seenOffsets: string[][] = [];

	const fakeFetch = (async (_url: string, init: RequestInit) => {
		const inputs = (JSON.parse(String(init.body)) as { inputs: string[] }).inputs;
		seenOffsets.push(inputs.map((text) => text.split(":")[0]!));
		const results = inputs.map((text) => {
			const index = Number(text.split(":")[0]!.slice(1));
			return { confidence: 0.5, scores: { unrelated: 1 - index / 10, adjacent: 0, applicable: index / 10 } };
		});
		return new Response(JSON.stringify({ results }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("t", skills, config, 7, undefined, fakeFetch);
	assert.equal(result.shards, 3);
	assert.deepEqual(seenOffsets, [["s0", "s1", "s2"], ["s3", "s4"], ["s5", "s6"]]);
	assert.equal(result.ranked.length, 7);
	// Highest index scores highest, so order must be s6..s0 with matching scores.
	assert.deepEqual(result.ranked.map((r) => r.skill.name), ["s6", "s5", "s4", "s3", "s2", "s1", "s0"]);
	for (const entry of result.ranked) {
		const index = Number(entry.skill.name.slice(1));
		assert.equal(entry.score, (2 * index) / 10, `${entry.skill.name} got another skill's score`);
	}
});

test("rankSkills survives a partial shard failure and reports it", async () => {
	const skills = Array.from({ length: 4 }, (_, index) => skill(`s${index}`, ""));
	const config = classifierConfig({ shardSize: 2, minScore: 1, fallback: false });
	let call = 0;
	const fakeFetch = (async (_url: string, init: RequestInit) => {
		if (call++ === 0) return new Response("boom", { status: 400 });
		const inputs = (JSON.parse(String(init.body)) as { inputs: string[] }).inputs;
		const results = inputs.map(() => ({ confidence: 0.6, scores: { unrelated: 0, adjacent: 0.1, applicable: 0.9 } }));
		return new Response(JSON.stringify({ results }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 5, undefined, fakeFetch);
	assert.equal(result.failures.length, 1);
	assert.equal(result.fallbacks, 0);
	assert.deepEqual(result.ranked.map((entry) => entry.skill.name), ["s2", "s3"]);
});

test("rankSkills throws when every shard fails", async () => {
	const config = classifierConfig({ shardSize: 2, fallback: false });
	const fakeFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
	await assert.rejects(
		() => rankSkills("t", [skill("a", "")], config, 3, undefined, fakeFetch),
		/Every Jev request failed/,
	);
});

test("rankSkills falls back to classifier.dev when TypeSafe fails", async () => {
	const skills = Array.from({ length: 4 }, (_, index) => skill(`s${index}`, ""));
	const config = typesafeConfig({ shardSize: 2, minScore: 1 });
	const urls: string[] = [];

	const fakeFetch = (async (url: string, init: RequestInit) => {
		urls.push(String(url));
		if (String(url) === TYPESAFE_ENDPOINT) return new Response("upstream is down", { status: 502 });
		const inputs = (JSON.parse(String(init.body)) as { inputs: string[] }).inputs;
		const results = inputs.map(() => ({ confidence: 0.7, scores: { unrelated: 0, adjacent: 0, applicable: 1 } }));
		return new Response(JSON.stringify({ model: "jev-1.13.0", results }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 5, undefined, fakeFetch);
	// Each shard burns its TypeSafe attempts (502 is retryable) before diverting.
	assert.ok(urls.includes(CLASSIFIER_ENDPOINT), "the free route must be tried");
	assert.equal(result.fallbacks, 2);
	assert.deepEqual(result.transports, ["classifier"], "transports names the services that answered");
	assert.deepEqual(result.failures, []);
	assert.equal(result.ranked.length, 4);
	assert.equal(result.ranked[0]!.score, 2);
});

test("rankSkills falls back to TypeSafe when classifier.dev fails and a key exists", async () => {
	const skills = [skill("a", ""), skill("b", "")];
	const config = classifierConfig({ apiKey: "key", shardSize: 2, minScore: 1 });
	const urls: string[] = [];

	const fakeFetch = (async (url: string, init: RequestInit) => {
		urls.push(String(url));
		if (String(url) === CLASSIFIER_ENDPOINT) return new Response("busy", { status: 429 });
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { score: 2, confidence: 0.9 };
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("a task", skills, config, 5, undefined, fakeFetch);
	assert.ok(urls.includes(TYPESAFE_ENDPOINT));
	assert.equal(result.fallbacks, 1);
	assert.deepEqual(result.transports, ["typesafe"], "transports names the services that answered");
	assert.equal(result.ranked.length, 2);
});

test("rankSkills never diverts when fallback is disabled", async () => {
	const config = classifierConfig({ apiKey: "key", shardSize: 2, fallback: false });
	const urls: string[] = [];
	const fakeFetch = (async (url: string) => {
		urls.push(String(url));
		return new Response("busy", { status: 429 });
	}) as unknown as typeof fetch;

	await assert.rejects(
		() => rankSkills("t", [skill("a", "")], config, 3, undefined, fakeFetch),
		/Every Jev request failed/,
	);
	assert.deepEqual(new Set(urls), new Set([CLASSIFIER_ENDPOINT]));
});

test("rankSkills returns nothing for an empty catalog instead of failing", async () => {
	const result = await rankSkills("t", [], classifierConfig(), 3, undefined, (async () => {
		throw new Error("no request should be made for an empty catalog");
	}) as unknown as typeof fetch);
	assert.deepEqual(result.ranked, []);
	assert.deepEqual(result.alsoRanked, []);
	assert.deepEqual(result.transports, []);
	assert.deepEqual(result.failures, []);
	assert.equal(result.shards, 0);
});

test("the TypeSafe key never reaches classifier.dev, whatever the config says", async () => {
	const configs: JevConfig[] = [
		typesafeConfig(),
		{ ...typesafeConfig(), endpoint: CLASSIFIER_ENDPOINT },
		{ ...typesafeConfig(), endpoint: CLASSIFIER_ENDPOINT, transport: "typesafe" },
		{ ...classifierConfig(), apiKey: "key", transport: "classifier" },
		{ ...classifierConfig(), apiKey: "key", endpoint: TYPESAFE_ENDPOINT },
		{ ...typesafeConfig(), endpoint: "https://proxy.example/v1/systemone" },
	];
	const seen: { url: string; authorization?: string }[] = [];

	for (const config of configs) {
		const fakeFetch = (async (url: string, init: RequestInit) => {
			seen.push({ url: String(url), authorization: (init.headers as Record<string, string>).Authorization });
			// Answer in whatever shape the URL calls for, so nothing retries.
			if (String(url).includes("classifier.dev")) {
				return new Response(
					JSON.stringify({ results: [{ confidence: 0.9, scores: { unrelated: 0, adjacent: 0, applicable: 1 } }] }),
					{ status: 200 },
				);
			}
			const body = JSON.parse(String(init.body)) as { questions?: Record<string, unknown> };
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(body.questions ?? { skill_0: {} })) answers[id] = { score: 2, confidence: 0.9 };
			return new Response(JSON.stringify({ answers }), { status: 200 });
		}) as unknown as typeof fetch;
		await rankSkills("t", [skill("a", "")], config, 1, undefined, fakeFetch);
	}

	assert.deepEqual(
		seen.filter((request) => request.url.includes("classifier.dev") && request.authorization),
		[],
		"the TypeSafe key must never be sent to classifier.dev",
	);
	assert.ok(seen.some((request) => request.url === CLASSIFIER_ENDPOINT), "classifier.dev is still used when it answers");
	assert.ok(seen.some((request) => request.url === TYPESAFE_ENDPOINT), "TypeSafe is still used when it answers");
});

test("rankClassifierResults leaves non-finite confidence at zero", () => {
	const answers = rankClassifierResults(
		{ results: [{ confidence: Number.NaN, scores: { unrelated: 0, adjacent: 1, applicable: 0 } }] },
		[skill("a", "")],
		0,
	);
	assert.equal(answers[questionId(0)]!.confidence, 0);
	assert.equal(answers[questionId(0)]!.score, 1);
});

test("rankSkills fails cleanly on a body that is not a JSON object", async () => {
	const config = classifierConfig({ fallback: false });
	const fakeFetch = (async () => new Response("null", { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
	await assert.rejects(
		() => rankSkills("t", [skill("a", "")], config, 1, undefined, fakeFetch),
		/not a JSON object/,
	);
});

test("rankSkills without an API key fails before any request", async () => {
	// A pinned keyed transport with no key is a configuration mistake, not an outage,
	// and must be reported instead of quietly diverting to classifier.dev.
	const config = typesafeConfig({ apiKey: undefined, transport: "typesafe" });
	let called = false;
	const fakeFetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
	await assert.rejects(
		() => rankSkills("t", [skill("a", "")], config, 3, undefined, fakeFetch),
		/No TypeSafe API key/,
	);
	assert.equal(called, false);
});

test("rankSkills sends each request shape to its own service, never a mismatched endpoint", async () => {
	// Pinned to the classifier shape, but the endpoint names TypeSafe: a classifier
	// body there is a 400, so the call goes to classifier.dev instead.
	const config = classifierConfig({ endpoint: TYPESAFE_ENDPOINT, minScore: 1 });
	const urls: string[] = [];
	const fakeFetch = (async (url: string, init: RequestInit) => {
		urls.push(String(url));
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		assert.equal("questions" in body, false, "the TypeSafe shape must not be posted to the pinned endpoint");
		const inputs = body.inputs as string[];
		return new Response(JSON.stringify({ results: inputs.map(() => ({ confidence: 0.9, scores: { unrelated: 0, adjacent: 0, applicable: 1 } })) }), { status: 200 });
	}) as unknown as typeof fetch;

	const result = await rankSkills("t", [skill("a", "")], config, 3, undefined, fakeFetch);
	assert.deepEqual(urls, [CLASSIFIER_ENDPOINT]);
	assert.equal(result.ranked.length, 1);

	// And the other way round: a TypeSafe pin with the classifier shape is not
	// posted to classifier.dev with questions either.
	const reversed = typesafeConfig({ endpoint: CLASSIFIER_ENDPOINT, minScore: 1 });
	const reversedUrls: string[] = [];
	const reversedFetch = (async (url: string, init: RequestInit) => {
		reversedUrls.push(String(url));
		const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(body.questions)) answers[id] = { score: 2, confidence: 0.9 };
		return new Response(JSON.stringify({ answers }), { status: 200 });
	}) as unknown as typeof fetch;

	await rankSkills("t", [skill("a", "")], reversed, 3, undefined, reversedFetch);
	assert.deepEqual(reversedUrls, [TYPESAFE_ENDPOINT]);
});

test("lexical fallback ranks an exact name match first", () => {
	const skills = [skill("qb", "qBittorrent"), skill("fleet", "run commands on remote hosts")];
	assert.equal(lexicalMatches(skills, "fleet", 5)[0]?.skill.name, "fleet");
	assert.deepEqual(lexicalMatches(skills, "zzzz", 5), []);
});

test("queryTerms drops stop words and single characters", () => {
	assert.deepEqual(queryTerms("run a command on the remote host"), ["run", "command", "remote", "host"]);
});
