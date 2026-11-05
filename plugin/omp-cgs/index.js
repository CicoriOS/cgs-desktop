// omp extension: registers the CGS (Cicori Good Service) providers.
//
// Reads <agentDir>/cgs/credentials.json (written by CGS Desktop after the
// device-link login) and registers three providers, partitioned by model id,
// exposing only the ids the server returned from GET <baseUrl>/v1/models:
//   cgs-anthropic  api anthropic-messages     baseUrl <baseUrl>          ids claude-*
//   cgs-gemini     api google-generative-ai   baseUrl <baseUrl>/v1beta   ids gemini-*
//   cgs-openai     api openai-completions     baseUrl <baseUrl>/v1       every other chat id
// Without valid credentials nothing is registered.
//
// Model metadata: omp's model registry fills every field a registered model
// leaves undefined (reasoning, input, contextWindow, maxTokens, cost) from its
// bundled catalog, matching by model id. The extension runtime resolves
// "@oh-my-pi/pi-catalog" to the host's bundled copy, so we ask the catalog
// whether it knows an id: if yes, only `thinking` is forwarded (the registry does
// not inherit it across providers) and the rest is inherited; if not (or the
// catalog is not importable, e.g. under plain Node), the conservative per-family
// table below supplies the metadata.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDER_ANTHROPIC = "cgs-anthropic";
export const PROVIDER_GEMINI = "cgs-gemini";
export const PROVIDER_OPENAI = "cgs-openai";

// Non-chat model ids (image/audio/embedding/moderation/rerank/video) are never registered.
const NON_CHAT_ID =
	/(^|[-_./])(image|images|imagen|dall-?e|embedding|embeddings|embed|whisper|tts|transcribe|moderation|rerank|sora|veo|video)([-_./\d]|$)/i;

// Conservative metadata for ids the omp catalog does not know, per model family.
// Any family without an entry uses FALLBACK_DEFAULT (omp's own defaults for unknown models).
export const FAMILY_FALLBACKS = [
	{ family: "claude", test: /^claude/i, reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 },
	{ family: "gemini", test: /^gemini/i, reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 65536 },
	{ family: "deepseek", test: /^deepseek/i, reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
	{ family: "glm", test: /^glm/i, reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
	{ family: "grok", test: /^grok/i, reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 8192 },
	{ family: "kimi", test: /^kimi/i, reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
	{ family: "minimax", test: /^minimax/i, reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192 },
];
export const FALLBACK_DEFAULT = { family: "other", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16384 };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function resolveAgentDir(env = process.env, home = os.homedir()) {
	const fromEnv = env.PI_CODING_AGENT_DIR;
	if (fromEnv && fromEnv.trim()) {
		const v = fromEnv.trim();
		if (v === "~") return home;
		if (v.startsWith("~/") || v.startsWith("~\\")) return path.join(home, v.slice(2));
		return path.resolve(v);
	}
	return path.join(home, ".omp", "agent");
}

export function readCredentials(agentDir) {
	let raw;
	try {
		raw = fs.readFileSync(path.join(agentDir, "cgs", "credentials.json"), "utf8");
	} catch {
		return null;
	}
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object") return null;
	const { baseUrl, apiKey, models } = data;
	if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
	if (typeof apiKey !== "string" || !apiKey.trim()) return null;
	if (!Array.isArray(models)) return null;
	return {
		baseUrl: baseUrl.trim().replace(/\/+$/, ""),
		apiKey: apiKey.trim(),
		models: [...new Set(models.filter(id => typeof id === "string" && id.trim()).map(id => id.trim()))],
	};
}

/** Which provider serves a model id, or null for non-chat ids. */
export function providerForModel(id) {
	if (NON_CHAT_ID.test(id)) return null;
	if (/^claude/i.test(id)) return PROVIDER_ANTHROPIC;
	if (/^gemini/i.test(id)) return PROVIDER_GEMINI;
	return PROVIDER_OPENAI;
}

export function familyFallback(id) {
	return FAMILY_FALLBACKS.find(f => f.test.test(id)) ?? FALLBACK_DEFAULT;
}

/** Model definition for registerProvider. `reference` is the catalog entry for the id, when known. */
export function buildModel(id, reference) {
	if (reference) {
		// Everything else is inherited from the catalog by the model registry.
		return { id, name: id, ...(reference.thinking ? { thinking: reference.thinking } : {}) };
	}
	const f = familyFallback(id);
	return {
		id,
		name: id,
		reasoning: f.reasoning,
		input: [...f.input],
		cost: { ...ZERO_COST },
		contextWindow: f.contextWindow,
		maxTokens: f.maxTokens,
	};
}

/**
 * Pure: credentials → { providerName: ProviderConfig } (providers without models are omitted).
 * `lookup(id)` returns the catalog reference model or undefined.
 */
export function buildProviders(credentials, lookup = () => undefined) {
	const { baseUrl, apiKey, models } = credentials;
	const defs = {
		[PROVIDER_ANTHROPIC]: { api: "anthropic-messages", baseUrl, models: [] },
		[PROVIDER_GEMINI]: { api: "google-generative-ai", baseUrl: `${baseUrl}/v1beta`, models: [] },
		[PROVIDER_OPENAI]: { api: "openai-completions", baseUrl: `${baseUrl}/v1`, models: [] },
	};
	for (const id of models) {
		const provider = providerForModel(id);
		if (provider) defs[provider].models.push(buildModel(id, lookup(id)));
	}
	const result = {};
	for (const [name, def] of Object.entries(defs)) {
		if (def.models.length === 0) continue;
		result[name] = { baseUrl: def.baseUrl, apiKey, api: def.api, models: def.models };
	}
	return result;
}

async function loadCatalogLookup() {
	try {
		const identity = await import("@oh-my-pi/pi-catalog/identity");
		const index = identity.getBundledModelReferenceIndex();
		return id => identity.resolveModelReference(id, index);
	} catch {
		return () => undefined;
	}
}

export default async function cgsExtension(pi) {
	const credentials = readCredentials(resolveAgentDir());
	if (!credentials) return;
	const providers = buildProviders(credentials, await loadCatalogLookup());
	for (const [name, config] of Object.entries(providers)) pi.registerProvider(name, config);
}
