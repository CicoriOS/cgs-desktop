// omp extension: registers the CGS (Cicori Good Service) providers.
//
// Reads <agentDir>/cgs/credentials.json (written by CGS Desktop after the
// device-link login) and registers four providers, one per omp channel,
// partitioned by model id and exposing only the ids the server returned from
// GET <baseUrl>/v1/models. Every channel is omp's own transport for that vendor
// (client fingerprint, wire format, tool-call style); only the URL and the
// credential (the client credential, never an API key) differ:
//   cgs-claude       api anthropic-messages       <baseUrl>      ids claude-*   (Claude Code channel)
//   cgs-antigravity  api google-gemini-cli        <baseUrl>      ids gemini-*   (Antigravity channel)
//   cgs-codex        api openai-codex-responses   <baseUrl>/v1   ids gpt-*, o*, codex*, *astra*
//   cgs-openai       api openai-completions       <baseUrl>/v1   every other chat id
// Without valid credentials nothing is registered.
//
// Model metadata: omp's model registry fills every field a registered model
// leaves undefined (reasoning, input, contextWindow, maxTokens, cost) from its
// bundled catalog, matching by model id, and derives catalog-only fields such as
// `webSearch: "gemini"` (what admits a chat model to the web-search role) from
// its compat rules by id, never from this plugin: the extension API cannot set
// them. We additionally ask the catalog (when importable) whether it knows an
// id: if yes, only `thinking` is forwarded (the registry does not inherit it
// across providers) and the rest is inherited; if not, the per-family table
// below supplies explicit metadata. A failed catalog import is logged, and the
// family table keeps every field defined, so nothing depends on resolving
// "@oh-my-pi/pi-catalog" from disk.
//
// Usage: cgs-openai (one provider only, to avoid duplicate rows) carries a usage
// provider that reads <root>/api/device/usage for ompweb's limits widget.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROVIDER_CLAUDE = "cgs-claude";
export const PROVIDER_ANTIGRAVITY = "cgs-antigravity";
export const PROVIDER_CODEX = "cgs-codex";
export const PROVIDER_OPENAI = "cgs-openai";
const ANTIGRAVITY_PROJECT = "cgs";

// OpenAI's own families (GPT, o-series, Codex, Astra) go through the Codex channel.
const CODEX_ID = /^(gpt|o\d|codex|chatgpt)|astra/i;

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
	const { baseUrl, clientSecret, models } = data;
	if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
	if (typeof clientSecret !== "string" || !clientSecret.trim()) return null;
	if (!Array.isArray(models)) return null;
	return {
		baseUrl: baseUrl.trim().replace(/\/+$/, ""),
		clientSecret: clientSecret.trim(),
		models: [...new Set(models.filter(id => typeof id === "string" && id.trim()).map(id => id.trim()))],
	};
}

/** Which provider (channel) serves a model id, or null for non-chat ids. */
export function providerForModel(id) {
	if (NON_CHAT_ID.test(id)) return null;
	if (/^claude/i.test(id)) return PROVIDER_CLAUDE;
	if (/^gemini/i.test(id)) return PROVIDER_ANTIGRAVITY;
	if (CODEX_ID.test(id)) return PROVIDER_CODEX;
	return PROVIDER_OPENAI;
}

export function familyFallback(id) {
	return FAMILY_FALLBACKS.find(f => f.test.test(id)) ?? FALLBACK_DEFAULT;
}

/**
 * Site price (CNY per million tokens) -> omp `cost`. Per-call models have no per-token price and stay unpriced.
 * The numbers are the site's real prices; omp's own cost displays still print its `$` glyph in front.
 */
export function costFromPrice(price) {
	if (!price || typeof price.input !== "number" || typeof price.output !== "number") return null;
	return {
		input: price.input,
		output: price.output,
		cacheRead: Number(price.cache_read) || 0,
		cacheWrite: Number(price.cache_write) || 0,
	};
}

/** Model definition for registerProvider. `reference` is the catalog entry for the id, when known; `price` the site's. */
export function buildModel(id, reference, price) {
	const cost = costFromPrice(price);
	if (reference) {
		// Everything else is inherited from the catalog by the model registry.
		return { id, name: id, ...(reference.thinking ? { thinking: reference.thinking } : {}), ...(cost ? { cost } : {}) };
	}
	const f = familyFallback(id);
	return {
		id,
		name: id,
		reasoning: f.reasoning,
		input: [...f.input],
		cost: cost ?? { ...ZERO_COST },
		contextWindow: f.contextWindow,
		maxTokens: f.maxTokens,
	};
}

/**
 * Pure: credentials → { providerName: ProviderConfig } (providers without models are omitted).
 * `lookup(id)` returns the catalog reference model or undefined.
 */
export function buildProviders(credentials, lookup = () => undefined, pricing = {}) {
	const { baseUrl, clientSecret, models } = credentials;
	// One omp transport per channel; only the credential and the URL differ from the upstream vendor's own.
	const defs = {
		// Claude Code channel: POST <root>/v1/messages, Bearer credential, Claude Code client fingerprint.
		[PROVIDER_CLAUDE]: { api: "anthropic-messages", baseUrl, apiKey: clientSecret, models: [] },
		// Antigravity channel (Cloud Code Assist wire): POST <root>/v1internal:streamGenerateContent. omp expects a
		// JSON credential {token, projectId}; the gateway ignores the project.
		[PROVIDER_ANTIGRAVITY]: {
			api: "google-gemini-cli",
			baseUrl,
			apiKey: JSON.stringify({ token: clientSecret, projectId: ANTIGRAVITY_PROJECT }),
			models: [],
		},
		// Codex channel: POST <root>/v1/codex/responses.
		[PROVIDER_CODEX]: { api: "openai-codex-responses", baseUrl: `${baseUrl}/v1`, apiKey: clientSecret, models: [] },
		// OpenAI-compatible channel: POST <root>/v1/chat/completions.
		[PROVIDER_OPENAI]: { api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: clientSecret, models: [] },
	};
	for (const id of models) {
		const provider = providerForModel(id);
		if (provider) defs[provider].models.push(buildModel(id, lookup(id), pricing[id]));
	}
	const result = {};
	for (const [name, def] of Object.entries(defs)) {
		if (def.models.length === 0) continue;
		result[name] = { baseUrl: def.baseUrl, apiKey: def.apiKey, api: def.api, models: def.models };
	}
	return result;
}

/** Plan windows ompweb can place; daily/never/custom resets have no correct slot and are not reported. */
const USAGE_WINDOWS = {
	weekly: { id: "7d", label: "7 Day", durationMs: 7 * 24 * 3600 * 1000 },
	monthly: { id: "monthly", label: "Monthly", durationMs: 30 * 24 * 3600 * 1000 },
};
export const USAGE_TIMEOUT_MS = 8000;

function usageStatus(fraction) {
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.85) return "warning";
	return "ok";
}

/**
 * Pure: GET /api/device/usage `data` → omp UsageReport, or null when no subscription has a limit ompweb can show
 * (unlimited, or reset_period other than weekly/monthly).
 */
export function buildUsageReport(data, provider, now = Date.now()) {
	const subs = Array.isArray(data?.subscriptions) ? data.subscriptions : [];
	const limits = [];
	const titles = [];
	for (const sub of subs) {
		const window = USAGE_WINDOWS[sub?.reset_period];
		const total = Number(sub?.amount_total);
		const used = Number(sub?.amount_used);
		if (!window || !(total > 0) || !Number.isFinite(used)) continue;
		const fraction = Math.max(0, used / total);
		const title = typeof sub.plan_title === "string" && sub.plan_title ? sub.plan_title : `Plan ${sub.plan_id ?? sub.id}`;
		if (!titles.includes(title)) titles.push(title);
		const resetsAt = Number(sub.next_reset_at) > 0 ? Number(sub.next_reset_at) * 1000 : undefined;
		const notes = [];
		if (sub.amount_used_display && sub.amount_total_display) notes.push(`${sub.amount_used_display} / ${sub.amount_total_display}`);
		limits.push({
			id: `cgs:${sub.id}:${window.id}`,
			label: `${title} ${window.label}`,
			scope: { provider, windowId: window.id },
			window: { id: window.id, label: window.label, durationMs: window.durationMs, ...(resetsAt ? { resetsAt } : {}) },
			amount: { used: fraction * 100, limit: 100, usedFraction: fraction, unit: "percent" },
			status: usageStatus(fraction),
			...(notes.length ? { notes } : {}),
		});
	}
	const balance = data?.balance;
	if (balance && Number.isFinite(Number(balance.cny))) {
		// omp's usage units have no CNY ('usd' would print dollars), so the yuan amount rides in `remaining` and the notes.
		limits.unshift({
			id: "cgs:balance",
			label: "\u4f59\u989d (CNY)",
			scope: { provider },
			amount: { remaining: Number(balance.cny), unit: "unknown" },
			status: Number(balance.quota) <= 0 ? "exhausted" : "ok",
			notes: [balance.cny_display || `\u00a5${Number(balance.cny).toFixed(2)}`],
		});
	}
	if (limits.length === 0) return null;
	const metadata = { planType: titles.length ? titles.join(" + ") : "Pay as you go" };
	if (balance && Number.isFinite(Number(balance.cny))) metadata.balanceCny = Number(balance.cny);
	if (typeof data.username === "string" && data.username) metadata.email = data.username;
	return { provider, fetchedAt: now, limits, metadata };
}

/**
 * UsageProvider for `provider` that queries `<root>/api/device/usage` with the client credential
 * (root = credentials baseUrl, not a provider baseUrl; the credential comes from credentials.json, since the
 * Antigravity channel's own apiKey is a JSON envelope).
 */
export function createUsageProvider({ baseUrl: root, clientSecret }, provider) {
	return {
		id: provider,
		cacheVersion: 3,
		validatesCredentials: false,
		async fetchUsage(params, ctx) {
			const timeout = AbortSignal.timeout(USAGE_TIMEOUT_MS);
			const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
			const res = await ctx.fetch(`${root}/api/device/usage`, {
				headers: { Authorization: `Bearer ${clientSecret}`, Accept: "application/json" },
				signal,
			});
			if (res.status === 401) return null;
			if (!res.ok) throw new Error(`CGS usage request failed: HTTP ${res.status}`);
			const body = await res.json();
			if (!body?.success || !body.data) throw new Error(`CGS usage request rejected: ${body?.message || "no data"}`);
			return buildUsageReport(body.data, provider);
		},
	};
}

async function loadCatalogLookup(logger) {
	try {
		const identity = await import("@oh-my-pi/pi-catalog/identity");
		const index = identity.getBundledModelReferenceIndex();
		return id => identity.resolveModelReference(id, index);
	} catch (error) {
		logger?.warn?.("cgs: pi-catalog identity not importable; using the per-family model table", {
			error: error instanceof Error ? error.message : String(error),
		});
		return () => undefined;
	}
}

/**
 * GET <root>/api/device/pricing -> { model: { input, output, cache_read?, cache_write? } } in CNY per million tokens
 * (the site's real prices after the group ratio), or null on any failure: pricing is best effort and must not
 * keep the providers from registering.
 */
export async function fetchPricing({ baseUrl: root, clientSecret }, doFetch = fetch) {
	try {
		const res = await doFetch(`${root}/api/device/pricing`, {
			headers: { Authorization: `Bearer ${clientSecret}`, Accept: "application/json" },
			signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const body = await res.json();
		if (!body?.success || body.data?.currency !== "CNY" || !body.data.models || typeof body.data.models !== "object") return null;
		return body.data.models;
	} catch {
		return null;
	}
}

export default async function cgsExtension(pi) {
	const credentials = readCredentials(resolveAgentDir());
	if (!credentials) return;
	const [lookup, pricing] = await Promise.all([loadCatalogLookup(pi.logger), fetchPricing(credentials)]);
	const providers = buildProviders(credentials, lookup, pricing ?? {});
	const usageOwner = [PROVIDER_OPENAI, PROVIDER_CLAUDE, PROVIDER_CODEX, PROVIDER_ANTIGRAVITY].find(name => providers[name]);
	if (usageOwner) providers[usageOwner].usage = createUsageProvider(credentials, usageOwner);
	for (const [name, config] of Object.entries(providers)) pi.registerProvider(name, config);
}
