// A fake CGS server for the desktop e2e (test/e2e/main.mjs): the device login the sidecar performs, the account the unit
// polls, the model/pricing/capability/layout endpoints the omp extension reads, and an OpenAI-compatible
// `/v1/chat/completions` that streams a scripted reply, so a real `omp --mode rpc-ui` child can answer a prompt.
//
// Everything is in memory. The device flow approves only after the verification URL was opened (the driver's window-open
// handler asks for it, standing in for the user's browser), which is what makes the UI path matter: a login that never
// opened the link stays `pending`.
import http from "node:http";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default scripted model replies: the first whose `match` occurs in the prompt's last user message wins (an empty match
 * is the fallback). Matching the prompt, not the request count, keeps title-generation and retry calls from stealing the
 * reply the test expects.
 */
export const DEFAULT_REPLIES = [
  { match: "SECOND-PROMPT", text: "FAKE-REPLY-TWO streamed while the window reloaded and reattached.", chunkDelayMs: 240, chunks: 24 },
  { match: "", text: "FAKE-REPLY-ONE The temporary workspace is ready.", chunkDelayMs: 200, chunks: 14 },
];

/**
 * Starts the fake server on a random loopback port.
 * @param {{ replies?: {text: string, chunks?: number, chunkDelayMs?: number}[], account?: object, models?: string[] }} [options]
 */
export async function startFakeCgs(options = {}) {
  const replies = (options.replies ?? DEFAULT_REPLIES).map((r) => ({ ...r }));
  const account = {
    username: "alice",
    tier: "pro",
    clientSecret: "fake-client-secret",
    ...options.account,
  };
  const models = options.models ?? ["qwen3-coder"];
  /** `<provider>/<model>` selector the extension's channel mapping produces for the first model (`channelForModel`). */
  const defaultSelector = `cgs-openai/${models[0]}`;
  const state = {
    /** Bodies of every request, in order: `METHOD /path`. */
    requests: [],
    /** The device session state: created -> challenged -> approved (only after the verification URL was fetched). */
    device: { sessionId: "s-fake-1", uuid: "u-fake-1", challenged: false, opened: false, openedAt: 0, approved: false, approvedAt: 0, polls: 0 },
    /** How many chat completions were served and with what body. */
    chat: [],
    /** Set to a non-empty string to answer every provider request with that HTTP status instead. */
    failProviderWith: undefined,
    loginOpenedAt: 0,
    logoutRevoked: false,
  };
  let port = 0;
  const base = () => `http://127.0.0.1:${port}`;

  const json = (res, body, status = 200) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const ok = (res, data) => json(res, { success: true, data });
  const html = (res, body) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>CGS login</title><p>${body}</p>`);
  };

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** The text of the request's last user message, whether it came as a string or as content parts. */
  function lastUserText(body) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "user") continue;
      if (typeof message.content === "string") return message.content;
      if (Array.isArray(message.content)) return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ");
      return "";
    }
    return "";
  }

  /** The SSE stream of one scripted reply, in the OpenAI chat-completions chunk format omp parses. */
  async function streamReply(res, reply, index, body, authorization) {
    const prompt = lastUserText(body);
    state.chat.push({
      at: Date.now(),
      prompt,
      stream: body?.stream === true,
      tools: Array.isArray(body?.tools) ? body.tools.length : 0,
      model: body?.model,
      authorized: authorization === `Bearer ${account.clientSecret}`,
      reply: reply.text,
    });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const id = `chatcmpl-fake-${index}`;
    const created = Math.floor(Date.now() / 1000);
    const frame = (delta, finish = null) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: typeof body?.model === "string" ? body.model : models[0],
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    chunk(frame({ role: "assistant", content: "" }));
    const parts = Math.max(1, reply.chunks ?? 1);
    const size = Math.ceil(reply.text.length / parts);
    for (let i = 0; i < reply.text.length; i += size) {
      if (reply.chunkDelayMs) await delay(reply.chunkDelayMs);
      chunk(frame({ content: reply.text.slice(i, i + size) }));
    }
    chunk(frame({}, "stop"));
    chunk({
      id,
      object: "chat.completion.chunk",
      created,
      model: typeof body?.model === "string" ? body.model : models[0],
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: reply.text.length, total_tokens: 12 + reply.text.length },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, base());
      const path = url.pathname;
      state.requests.push(`${req.method} ${path}${url.search}`);

      // ---- device login ------------------------------------------------------------------------------------
      if (req.method === "POST" && path === "/api/device/sessions") {
        state.device = { ...state.device, sessionId: "s-fake-1", uuid: "u-fake-1", challenged: false, openedAt: 0, approved: false, polls: 0 };
        state.loginOpenedAt = 0;
        return ok(res, { session_id: "s-fake-1", challenge: { prefix: "cgs", difficulty: 2, algorithm: "sha256" }, expires_in: 600 });
      }
      if (req.method === "POST" && /^\/api\/device\/sessions\/[^/]+\/challenge$/.test(path)) {
        await readBody(req);
        state.device.challenged = true;
        return ok(res, {
          uuid: state.device.uuid,
          poll_token: "poll-token",
          expires_at: Math.floor(Date.now() / 1000) + 600,
          verification_url: `${base()}/device/verify?uuid=${state.device.uuid}`,
        });
      }
      if (req.method === "POST" && /^\/api\/device\/sessions\/[^/]+\/poll$/.test(path)) {
        await readBody(req);
        state.device.polls += 1;
        if (!state.device.challenged) return json(res, { success: false, error: "unknown session" }, 404);
        if (!state.device.opened) return ok(res, { status: "pending" });
        // The browser said yes; the poll now hands out the credential.
        state.device.approved = true;
        state.device.approvedAt ||= Date.now();
        return ok(res, { status: "approved", client_secret: account.clientSecret, tier: account.tier, username: account.username });
      }
      if (req.method === "GET" && path === "/device/verify") {
        // The user's browser opens this: only now may the poll succeed.
        state.device.opened = true;
        state.device.openedAt ||= Date.now();
        state.loginOpenedAt ||= Date.now();
        return html(res, "This device is approved. You can return to CGS Desktop.");
      }
      if (req.method === "POST" && path === "/api/device/logout") {
        state.logoutRevoked = true;
        return json(res, { success: true, data: { revoked: true } });
      }

      // ---- the account the unit polls ----------------------------------------------------------------------
      if (req.method === "GET" && path === "/api/device/tier") {
        return ok(res, { tier: account.tier, username: account.username });
      }
      if (req.method === "GET" && path === "/api/device/usage") {
        const now = Math.floor(Date.now() / 1000);
        return ok(res, {
          tier: account.tier,
          username: account.username,
          balance: { quota: 20000, used_quota: 100, display: "$199.99", cny_display: "$199.99" },
          generated_at: now,
          subscriptions: [
            {
              id: 7,
              plan_id: 3,
              plan_title: "Pro Max",
              amount_total: 100,
              amount_used: 25,
              amount_total_display: "$100.00",
              amount_used_display: "$25.00",
              reset_period: "monthly",
              next_reset_at: now + 12 * 24 * 3600,
              start_time: now - 18 * 24 * 3600,
              end_time: 0,
            },
          ],
        });
      }
      if (req.method === "GET" && path === "/api/device/layout") {
        return ok(res, { orchestrator: { model: defaultSelector, thinking: "low" }, agents: [], web_model: "" });
      }

      // ---- what the omp extension reads ---------------------------------------------------------------
      if (req.method === "GET" && path === "/v1/models") {
        return json(res, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "fake" })) });
      }
      if (req.method === "GET" && path === "/api/device/pricing") {
        return ok(res, {
          currency: "USD",
          models: Object.fromEntries(models.map((id) => [id, { input: 0.15, output: 0.6, cache_read: 0.075 }])),
        });
      }
      if (req.method === "GET" && path === "/api/device/models") {
        return ok(res, {
          models: Object.fromEntries(
            models.map((id) => [id, { input: ["text"], thinking_levels: [], context_window: 128000, max_output_tokens: 8192 }]),
          ),
        });
      }

      // ---- provider traffic --------------------------------------------------------------------------
      if (req.method === "POST" && path === "/v1/chat/completions") {
        if (state.failProviderWith) {
          const status = Number(state.failProviderWith);
          await readBody(req);
          return json(res, { error: { message: "fake provider failure", type: "server_error" } }, status);
        }
        const peek = await readBody(req);
        const prompt = lastUserText(peek);
        // Title generation must never take the slow scripted stream: it would delay the title, not the test.
        const titled = prompt.includes("<title-request>");
        const reply = titled
          ? replies.find((r) => r.match === "") ?? replies.at(-1)
          : replies.find((r) => r.match === "" || prompt.includes(r.match)) ?? replies.at(-1);
        return streamReply(res, reply, state.chat.length, peek, req.headers.authorization);
      }

      json(res, { error: `no route ${req.method} ${path}` }, 404);
    })().catch((error) => {
      try {
        json(res, { error: String(error) }, 500);
      } catch {
        res.destroy();
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = server.address().port;

  return {
    url: base(),
    state,
    account,
    models,
    defaultSelector,
    replies,
    /** The request paths handled so far, for assertions in the log. */
    get requests() {
      return [...state.requests];
    },
    /** The `verification_url` the sidecar handed the page (set once a challenge was served). */
    verificationUrl() {
      return state.device.challenged ? `${base()}/device/verify?uuid=${state.device.uuid}` : undefined;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
