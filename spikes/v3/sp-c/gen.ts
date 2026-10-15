import { operations } from "./ops.ts";
import { pathToFileURL } from "node:url";

function bodySchema(op: (typeof operations)[number]) {
  const pathNames = new Set([...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]));
  const properties = op.input.properties as Record<string, unknown>;
  return {
    ...op.input,
    properties: Object.fromEntries(Object.entries(properties).filter(([name]) => !pathNames.has(name))),
    required: (op.input.required as string[]).filter((name) => !pathNames.has(name)),
  };
}

const openapi = {
  openapi: "3.1.0",
  info: { title: "Concord prototype API", version: "0.0.1" },
  paths: Object.fromEntries(operations.map((op) => [op.path, {
    [op.method.toLowerCase()]: {
      operationId: op.name,
      summary: op.summary,
      "x-concord-scope": op.scope,
      "x-concord-read-budget": op.readBudget,
      parameters: Object.entries(op.input.properties as Record<string, Record<string, unknown>>)
        .filter(([name]) => op.path.includes(`{${name}}`))
        .map(([name, schema]) => ({ name, in: "path", required: true, schema })),
      ...(op.method === "GET" ? {
        ...(op.name === "list_ready_issues" ? { parameters: [
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
        ] } : {}),
      } : { requestBody: { required: true, content: { "application/json": { schema: bodySchema(op) } } } }),
      responses: { "200": { description: "Operation result", content: { "application/json": { schema: op.output } } } },
    },
  }])) ,
};

const cli = ["concord-api <operation> [arguments]", "", ...operations.map((op) =>
  `  ${op.name.padEnd(20)} ${op.method} ${op.path}  scope=${op.scope} read<=${op.readBudget.maximum} ${op.readBudget.units}`,
)].join("\n");

const mcp = {
  jsonrpc: "2.0", id: 1,
  result: { tools: operations.map((op) => ({
    name: op.name,
    description: `${op.summary}. Scope: ${op.scope}. Read budget: ${op.readBudget.maximum} ${op.readBudget.units}.`,
    inputSchema: op.input,
    outputSchema: op.output,
  })) },
};

export function generate(): string {
  return ["=== OpenAPI 3.1 ===", JSON.stringify(openapi, null, 2), "=== CLI help ===", cli, "=== MCP tools/list ===", JSON.stringify(mcp, null, 2)].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(generate());
