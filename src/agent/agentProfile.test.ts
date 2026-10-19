/**
 * The `agent` block of public/haven-app.json and the guides in public/agent/ tell agents
 * what the App Builder's tools do before the builder runs. This keeps them in step with
 * the tools: every capability names registered tools, every tool belongs to a
 * capability, and no guide or description names a tool that does not exist.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkAgentManifest } from "mindoodb-app-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  BUILDER_AGENT_TOOL_PREFIX,
  createBuilderAgentTools,
  type BuilderAgentDeps,
} from "@/agent/builderAgentTools";

// jsdom gives import.meta.url an http URL; vitest runs from the repo root.
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("the App Builder's agent profile", () => {
  const definition = JSON.parse(read("public/haven-app.json"));
  // Only the declarations are read; no tool runs.
  const tools = createBuilderAgentTools({} as BuilderAgentDeps);

  it("uses the prefix the tool descriptions refer to", () => {
    expect(definition.agentToolPrefix).toBe(BUILDER_AGENT_TOOL_PREFIX);
  });

  it("matches the registered tools and the agent guides", () => {
    const guides = definition.agent.guide as Record<string, string>;
    const result = checkAgentManifest({
      definition,
      tools,
      guideTexts: {
        ...Object.fromEntries(
          Object.values(guides).map((path) => [path.split("/").pop()!, read(`public/${path}`)]),
        ),
        ...Object.fromEntries(tools.map((tool) => [`${tool.name} description`, tool.description])),
      },
    });
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it("offers every capability, example and limit in English and German", () => {
    const agent = definition.agent;
    for (const locale of ["en", "de"]) {
      expect(agent.summary[locale]).toBeTruthy();
      expect(agent.examples[locale].length).toBeGreaterThan(0);
      expect(agent.limits[locale].length).toBeGreaterThan(0);
      for (const capability of agent.capabilities) {
        expect(capability.title[locale]).toBeTruthy();
      }
    }
  });

  it("keeps the guides within what Haven loads", () => {
    for (const path of Object.values(definition.agent.guide as Record<string, string>)) {
      expect(new TextEncoder().encode(read(`public/${path}`)).length).toBeLessThanOrEqual(8 * 1024);
    }
  });
});
