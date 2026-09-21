/**
 * Drives the real extension factory through a fake ExtensionAPI, once in the
 * shape upstream Pi hands over and once in the shape omp (oh-my-pi) does. The
 * services are never reached: fetch is stubbed with recorded classifier.dev
 * responses, and skills are real files in a temp directory.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import skillJev from "../extensions/skill-jev.ts";
import { CLASSIFIER_ENDPOINT } from "../extensions/jev.ts";

interface FakeTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: (update: { content: { type: string; text: string }[]; details?: unknown }) => void,
		ctx?: { cwd: string },
	): Promise<{ content: { type: string; text: string }[]; details?: Record<string, unknown>; isError?: boolean }>;
}

interface Harness {
	pi: ExtensionAPI;
	run(event: string, payload: unknown, ctx?: { cwd: string }): Promise<Record<string, unknown> | undefined>;
	tool(name: string): FakeTool;
}

function harness(injected?: unknown): Harness {
	const handlers = new Map<string, ((event: unknown, ctx?: { cwd: string }) => Promise<Record<string, unknown> | undefined>)[]>();
	const tools = new Map<string, FakeTool>();
	const pi = {
		pi: injected,
		on(event: string, handler: (event: unknown, ctx?: { cwd: string }) => Promise<Record<string, unknown> | undefined>) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: FakeTool) {
			tools.set(tool.name, tool);
		},
	};
	return {
		pi: pi as unknown as ExtensionAPI,
		async run(event, payload, ctx) {
			const registered = handlers.get(event) ?? [];
			let result: Record<string, unknown> | undefined;
			for (const handler of registered) result = await handler(payload, ctx);
			return result;
		},
		tool(name) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`tool ${name} was not registered`);
			return tool;
		},
	};
}

const root = mkdtempSync(join(tmpdir(), "skill-jev-"));
after(() => rmSync(root, { recursive: true, force: true }));
function writeSkill(name: string, description: string): { path: string; baseDir: string } {
	const baseDir = join(root, name);
	mkdirSync(baseDir, { recursive: true });
	const path = join(baseDir, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${name.toUpperCase()} body.\n`);
	return { path, baseDir };
}

const fleet = writeSkill("fleet", "Run commands on remote hosts");
const qb = writeSkill("qb", "qBittorrent housekeeping");
const hidden = writeSkill("secret", "Internal only");

const fleetSkill = { name: "fleet", description: "Run commands on remote hosts", filePath: fleet.path, baseDir: fleet.baseDir };
const qbSkill = { name: "qb", description: "qBittorrent housekeeping", filePath: qb.path, baseDir: qb.baseDir };

/** Keeps the developer's own skill-jev.json and keys out of the test. */
async function isolated(run: () => Promise<void>): Promise<void> {
	const saved = { ...process.env };
	for (const name of Object.keys(process.env)) {
		if (name.startsWith("PI_SKILL_JEV_") || name === "PI_CODING_AGENT_DIR" || name === "TYPESAFE_API_KEY"
			|| name === "CLASSIFY_API_KEY" || name === "CLASSIFIER_API_KEY") {
			delete process.env[name];
		}
	}
	process.env.PI_SKILL_JEV_CONFIG = join(root, "missing-config.json");
	try {
		await run();
	} finally {
		for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
		Object.assign(process.env, saved);
	}
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) =>
		handler(String(url), init ?? {})) as unknown as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

function classifierReply(inputs: string[], scores: Record<string, number>) {
	const results = inputs.map(() => ({ label: "applicable", confidence: 0.9, scores }));
	return new Response(JSON.stringify({ tier: "fast", model: "jev-1.13.0", results, usage: { classifications: results.length } }), { status: 200 });
}

test("upstream Pi: the catalog is stripped and the enabled skills are ranked", async () => {
	await isolated(async () => {
		const h = harness();
		skillJev(h.pi);

		const catalog = [
			"You are Pi.",
			"",
			"<skills>",
			"- fleet: Run commands on remote hosts",
			"- qb: qBittorrent housekeeping",
			"</skills>",
			"",
			"<cwd>/tmp</cwd>",
		].join("\n");

		const result = await h.run("before_agent_start", {
			systemPrompt: catalog,
			systemPromptOptions: { skills: [fleetSkill, qbSkill] },
		});
		const prompt = result?.systemPrompt as string;
		assert.equal(typeof prompt, "string");
		assert.ok(!prompt.includes("<skills>"), "the catalog must leave the prompt");
		assert.ok(!prompt.includes("fleet"));
		assert.ok(prompt.includes("<cwd>/tmp</cwd>"), "the rest of the prompt must survive");

		const bodies: Record<string, unknown>[] = [];
		const restore = stubFetch((url, init) => {
			assert.equal(url, CLASSIFIER_ENDPOINT);
			const body = JSON.parse(String(init.body)) as { inputs: string[] };
			bodies.push(body as unknown as Record<string, unknown>);
			// fleet is the one that applies; qb is not.
			return classifierReply(
				body.inputs,
				{ unrelated: 0, adjacent: 0, applicable: 1 },
			);
		});

		try {
			const search = await h.tool("skill_search").execute("call", { task: "restart jellyfin over ssh" }, undefined, undefined, { cwd: root });
			assert.equal(search.details?.transport, "classifier");
			assert.equal(search.details?.totalSkills, 2);
			assert.ok(search.content[0]!.text.includes("FLEET body."), "the winning skill is loaded in full");
			assert.ok(!search.content[0]!.text.includes("---\nname"), "frontmatter is stripped");
			assert.equal(bodies.length, 1);
			assert.deepEqual(bodies[0]!.labels, ["unrelated", "adjacent", "applicable"]);

			const load = await h.tool("skill_load").execute("call", { names: ["QB"] }, undefined, undefined, { cwd: root });
			assert.deepEqual(load.details?.loaded, ["qb"], "a case slip resolves to the same skill");
			assert.ok(load.content[0]!.text.includes("QB body."));
		} finally {
			restore();
		}
	});
});

test("omp: the prompt parts lose the catalog, its heading and its skill:// pointer", async () => {
	await isolated(async () => {
		let liveReads = 0;
		const h = harness({
			getActiveSkills: () => {
				liveReads++;
				return [fleetSkill, qbSkill, { ...hiddenSkillEntry(), hide: true }];
			},
		});
		skillJev(h.pi);

		const parts = [
			[
				"§ Runtime",
				"# Skills & Rules",
				"Matching skill → MUST read `skill://<name>` first.",
				"<skills>",
				"- fleet: Run commands on remote hosts",
				"</skills>",
				"",
				"<generic-rules>",
				"Rule one.",
				"</generic-rules>",
			].join("\n"),
			"A footer part.",
		];

		const result = await h.run("before_agent_start", { systemPrompt: parts, prompt: "hi" });
		const returned = result?.systemPrompt;
		assert.ok(Array.isArray(returned), "omp takes the prompt back as parts");
		const stripped = (returned as string[])[0]!;
		assert.ok(!stripped.includes("<skills>"));
		assert.ok(!stripped.includes("Matching skill"));
		assert.ok(stripped.includes("<generic-rules>"));
		// omp drops an extension's promptGuidelines, so the pointer to skill_search
		// has to be in the prompt where the catalog used to be.
		assert.ok(stripped.includes("intentionally left out of this prompt"), "the guidance must replace the catalog");
		assert.ok(stripped.includes("skill_search"));
		assert.equal((returned as string[])[1], "A footer part.");
		assert.ok(liveReads > 0, "omp's live skill set is read");
	});
});

test("omp: skills come from the live set, hidden ones stay out of the ranking", async () => {
	await isolated(async () => {
		const h = harness({ getActiveSkills: () => [fleetSkill, qbSkill, { ...hiddenSkillEntry(), hide: true }] });
		skillJev(h.pi);

		const sent: string[] = [];
		const restore = stubFetch((_url, init) => {
			const body = JSON.parse(String(init.body)) as { inputs: string[] };
			sent.push(...body.inputs);
			return classifierReply(body.inputs, { unrelated: 0, adjacent: 0.5, applicable: 0.5 });
		});

		try {
			// No before_agent_start first: omp is read live, not cached from a turn.
			const search = await h.tool("skill_search").execute("call", { task: "restart jellyfin" }, undefined, undefined, { cwd: root });
			assert.equal(search.details?.totalSkills, 2);
			assert.equal(sent.length, 2);
			assert.ok(sent.some((input) => input.startsWith("fleet:")));
			assert.ok(!sent.some((input) => input.startsWith("secret:")), "hidden skills are not model-invocable");
		} finally {
			restore();
		}
	});
});

test("omp: skill_load falls back to discovery when the harness exposes no live snapshot", async () => {
	await isolated(async () => {
		const h = harness({
			loadSkills: async () => ({ skills: [fleetSkill] }),
		});
		skillJev(h.pi);

		const load = await h.tool("skill_load").execute("call", { names: ["fleet"] }, undefined, undefined, { cwd: root });
		assert.deepEqual(load.details?.loaded, ["fleet"]);
	});
});

test("a name that matches nothing returns close alternatives instead of failing", async () => {
	await isolated(async () => {
		const h = harness();
		skillJev(h.pi);
		await h.run("before_agent_start", { systemPrompt: "You are Pi.", systemPromptOptions: { skills: [fleetSkill, qbSkill] } });

		const load = await h.tool("skill_load").execute("call", { names: ["fllet"] }, undefined, undefined, { cwd: root });
		assert.equal(load.isError, true);
		assert.ok(load.content[0]!.text.includes("No skill named 'fllet'"));
		assert.ok(load.content[0]!.text.includes("fleet"), "the close match must be named");
	});
});

function hiddenSkillEntry() {
	return { name: "secret", description: "Internal only", filePath: hidden.path, baseDir: hidden.baseDir };
}
