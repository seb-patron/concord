#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConcordClient, ConcordError, redactOutput, redactString } from '../cli/client.ts';
import { callTool, tools } from './tools.ts';

export async function startServer(): Promise<Server> {
  const url = process.env.CONCORD_URL;
  const token = process.env.CONCORD_TOKEN;
  if (!url || !token) throw new ConcordError('CONCORD_URL and CONCORD_TOKEN are required', 'usage');
  const client = new ConcordClient({ url, token });
  const server = new Server({ name: 'concord', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const output = await callTool(client, request.params.name, request.params.arguments ?? {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
    } catch (error) {
      const safe = error instanceof ConcordError
        ? { kind: error.kind, status: error.status, message: redactString(error.message), payload: error.payload, omittedMembers: error.omittedMembers }
        : { kind: 'server', message: redactString(error instanceof Error ? error.message : String(error)) };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(redactOutput(safe)) }] };
    }
  });
  await server.connect(new StdioServerTransport());
  return server;
}

startServer().catch(error => {
  // Keep startup diagnostics fixed; an invalid URL may itself contain credentials.
  process.stderr.write(error instanceof ConcordError && error.kind === 'usage' ? 'Concord MCP configuration is missing or invalid\n' : 'Concord MCP could not start\n');
  process.exitCode = 1;
});
