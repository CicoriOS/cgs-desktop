import { NATIVE_PROVIDERS } from "./provider-preview";

// OMP v19.2.1, packages/catalog/src/compat/provider-ids.ts (KnownProvider).
const ids = `abliteration aiand aimlapi alibaba-coding-plan alibaba-token-plan amazon-bedrock anthropic antigravity-cli apple azure baseten bedrock-mantle bifrost cerebras charm-hyper chutes cline-pass cloudflare-ai-gateway cloudflare-workers-ai commandcode coralbricks coreweave cursor deepinfra deepseek devin factory-droid firepass fireworks github-copilot gitlab-duo gitlab-duo-agent gmi-cloud google google-antigravity google-vertex groq helmcode huggingface inception kilo kimi-code kiro liquid litellm lm-studio local meta minimax minimax-code minimax-code-cn mistral modal modular moonshot muse-code nace nanogpt novita nvidia ollama ollama-cloud openai openai-codex opencode-go opencode-zen openrouter otari qianfan qwen-portal sakana sambanova scaleway siliconflow siliconflow-cn singularityapi-dev singularityapi-tech snowflake stepfun synthetic together typesafe umans venice vercel-ai-gateway vllm wafer-serverless web xai xai-oauth xiaomi xiaomi-token-plan-ams xiaomi-token-plan-cn xiaomi-token-plan-sgp yolo-auto zai zenmux zhipu-coding-plan`.split(" ");

const names: Record<string, string> = {
  aimlapi: "AI/ML API", deepinfra: "DeepInfra", deepseek: "DeepSeek", google: "Google Gemini", "google-vertex": "Google Vertex AI",
  "gmi-cloud": "GMI Cloud", huggingface: "Hugging Face", litellm: "LiteLLM", "lm-studio": "LM Studio", minimax: "MiniMax",
  nanogpt: "NanoGPT", nvidia: "NVIDIA", openai: "OpenAI", openrouter: "OpenRouter", qianfan: "Baidu Qianfan",
  sambanova: "SambaNova", siliconflow: "SiliconFlow", stepfun: "StepFun", vllm: "vLLM", xai: "xAI", zai: "Z.AI",
};
const logoGroups: Record<string, string> = {
  aimlapi: "aimlapi", "alibabacloud-color": "alibaba-coding-plan alibaba-token-plan", "bedrock-color": "amazon-bedrock bedrock-mantle",
  "antigravity-color": "antigravity-cli google-antigravity", apple: "apple", "azure-color": "azure", baseten: "baseten",
  "cerebras-color": "cerebras", chutes: "chutes", cline: "cline-pass", "cloudflare-color": "cloudflare-ai-gateway cloudflare-workers-ai",
  commandcode: "commandcode", cursor: "cursor", "deepinfra-color": "deepinfra", "deepseek-color": "deepseek", "devin-color": "devin",
  "fireworks-color": "fireworks", githubcopilot: "github-copilot", gmicloud: "gmi-cloud", "vertexai-color": "google-vertex", groq: "groq",
  gitlab: "gitlab-duo gitlab-duo-agent", modal: "modal", scaleway: "scaleway",
  "huggingface-color": "huggingface", inception: "inception", kilocode: "kilo", "kimi-color": "kimi-code", "kiro-color": "kiro",
  liquid: "liquid", lmstudio: "lm-studio", "meta-color": "meta", "minimax-color": "minimax minimax-code minimax-code-cn",
  "mistral-color": "mistral", moonshot: "moonshot", "muse-color": "muse-code", "novita-color": "novita", "nvidia-color": "nvidia",
  ollama: "ollama ollama-cloud", openai: "openai", opencode: "opencode-go opencode-zen", "openrouter-color": "openrouter",
  "baiducloud-color": "qianfan", "qwen-color": "qwen-portal", "sakana-color": "sakana", "sambanova-color": "sambanova",
  "siliconcloud-color": "siliconflow siliconflow-cn", "snowflake-color": "snowflake", "stepfun-color": "stepfun",
  "together-color": "together", typesafeai: "typesafe", "venice-color": "venice", vercel: "vercel-ai-gateway",
  "vllm-color": "vllm", wafer: "wafer-serverless", xai: "xai xai-oauth",
  xiaomimimo: "xiaomi xiaomi-token-plan-ams xiaomi-token-plan-cn xiaomi-token-plan-sgp", zai: "zai",
  zenmux: "zenmux", "zhipu-color": "zhipu-coding-plan",
};
const logos = new Map<string, string>(Object.entries(logoGroups).flatMap(([logo, group]) => group.split(" ").map((id) => [id, `provider-logos/${logo}.svg`] as const)));
logos.set("google", "gemini-mark.svg");

export const OMP_PROVIDERS = [
  ...NATIVE_PROVIDERS.map((native) => ({ ...native, id: native.id === "codex" ? "openai-codex" : "anthropic", native })),
  ...ids.filter((id) => id !== "openai-codex" && id !== "anthropic").map((id) => ({
    id,
    name: names[id] ?? id.replace(/(^|-)([a-z])/g, (_, sep: string, initial: string) => `${sep ? " " : ""}${initial.toUpperCase()}`),
    logo: logos.get(id),
    native: undefined,
  })),
];
