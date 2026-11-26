import { expect, test } from "vitest";
import { providerKind } from "../src/ui/format";

test.each([
  ["cgs-claude", "relay"],
  ["cgs-openai", "relay"],
  ["anthropic", "direct"],
  ["openai", "direct"],
])("classifies %s as %s", (provider, kind) => {
  expect(providerKind(provider)).toBe(kind);
});
