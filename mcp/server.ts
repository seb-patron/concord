#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConcordClient, ConcordError, redactOutput, redactString } from '../cli/client.ts';
import { callTool, tools } from './tools.ts';
import { addProfileRejectionContext, resolveCredential } from '../cli/profile.ts';

export async function startServer(): Promise<Server> {
  const credential = await resolveCredential({});
  const client = addProfileRejectionContext(new ConcordClient({ url: credential.url, token: credential.token }), credential.profileName);
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
  const message = error instanceof ConcordError && /^PROFILE_(?:NOT_FOUND|TOKEN_UNREADABLE|PERMISSIONS):/.test(error.message)
    ? error.message : error instanceof ConcordError && error.kind === 'usage'
      ? 'Concord MCP configuration is missing or invalid' : 'Concord MCP could not start';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
