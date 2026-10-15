/** One declarative table is the source for route, OpenAPI, CLI and MCP metadata. */
export type Operation = {
  name: string;
  summary: string;
  method: "GET" | "PUT";
  path: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  scope: string;
  readBudget: { units: string; maximum: number };
};

const string = { type: "string" } as const;
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});

export const operations: Operation[] = [
  {
    name: "read_file",
    summary: "Read one file from a repository",
    method: "GET",
    path: "/v1/repos/{repo}/files/{path}",
    input: object({ repo: string, path: string }, ["repo", "path"]),
    output: object({ repo: string, path: string, content: string, bytes: { type: "integer", minimum: 0 } }, ["repo", "path", "content", "bytes"]),
    scope: "repo:read",
    readBudget: { units: "bytes returned", maximum: 262144 },
  },
  {
    name: "put_change",
    summary: "Create a changeset from file contents",
    method: "PUT",
    path: "/v1/repos/{repo}/changes",
    input: object({ repo: string, title: string, files: { type: "object", additionalProperties: string } }, ["repo", "title", "files"]),
    output: object({ changeId: string, status: { type: "string", enum: ["draft"] } }, ["changeId", "status"]),
    scope: "repo:changes:write",
    readBudget: { units: "repository rows", maximum: 0 },
  },
  {
    name: "list_ready_issues",
    summary: "List issues currently marked ready",
    method: "GET",
    path: "/v1/repos/{repo}/issues/ready",
    input: object({ repo: string, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["repo"]),
    output: object({ issues: { type: "array", maxItems: 100, items: object({ id: string, title: string, state: { type: "string", const: "ready" } }, ["id", "title", "state"]) } }, ["issues"]),
    scope: "repo:issues:read",
    readBudget: { units: "issue rows", maximum: 100 },
  },
];
