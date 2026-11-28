// Network helpers for the first-run downloads (ADR 0049 §2 proxy, §4 source racing).
//
// Proxy: Electron's `session.resolveProxy(url)` answers in Chromium's PAC syntax (`PROXY host:port; DIRECT`). aria2, bun, pip and
// rustup take an http proxy URL, so the first usable entry becomes one. SOCKS entries and proxies that need credentials in the
// answer are not translated: those downloads go without a proxy rather than through a wrong one ([未决 O24]).
//
// Racing: every download type has several sources. A small ranged request per candidate measures them; the fastest that answers
// is tried first, the rest follow in order of speed, and the ones that did not answer come last. The order is cached for a while
// and a source that failed a real download is demoted. Sources are not trusted: the caller checks SHA-256.

/** `PROXY 127.0.0.1:7890; DIRECT` -> `http://127.0.0.1:7890`; undefined for DIRECT, SOCKS or an unreadable answer. */
export function proxyUrlFromPac(answer) {
  if (typeof answer !== "string") return undefined;
  for (const entry of answer.split(";")) {
    const match = /^\s*(PROXY|HTTPS|HTTP)\s+(\S+)\s*$/i.exec(entry);
    if (match) return `${/^https$/i.test(match[1]) ? "https" : "http"}://${match[2]}`;
    if (/^\s*DIRECT\s*$/i.test(entry)) return undefined;
  }
  return undefined;
}

/** Environment a child process (bun, pip, rustup) needs to use the same proxy. */
export function proxyEnv(proxy) {
  if (!proxy) return {};
  return {
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  };
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export function createRacer({ fetch, now = Date.now, ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const cache = new Map();

  async function probe(url) {
    const started = now();
    try {
      const response = await fetch(url, { method: "GET", headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
      await response.body?.cancel?.().catch(() => {});
      if (response.status !== 200 && response.status !== 206) return { ok: false };
      return { ok: true, ms: now() - started };
    } catch {
      return { ok: false };
    }
  }

  return {
    /**
     * `candidates` ordered fastest first. `probeUrl` maps a candidate to the URL that proves it works (a file URL for a file
     * source, `<registry>/<package>` for a registry). The result is cached under `key`.
     */
    async order(key, candidates, probeUrl = (candidate) => candidate) {
      const cached = cache.get(key);
      if (cached && now() - cached.at < ttlMs && candidates.every((candidate) => cached.order.includes(candidate))) return [...cached.order];
      const results = await Promise.all(candidates.map(async (candidate) => ({ candidate, ...(await probe(probeUrl(candidate))) })));
      const answered = results.filter((result) => result.ok).sort((a, b) => a.ms - b.ms);
      const silent = results.filter((result) => !result.ok);
      const order = [...answered, ...silent].map((result) => result.candidate);
      cache.set(key, { at: now(), order });
      return [...order];
    },
    /** A source failed a real download: the next race must not put it first again. */
    demote(key, candidate) {
      const cached = cache.get(key);
      if (!cached) return;
      cached.order = [...cached.order.filter((item) => item !== candidate), candidate];
    },
    forget(key) {
      cache.delete(key);
    },
  };
}
