// The MCP endpoint at /mcp: JSON-RPC 2.0 over streamable HTTP, speaking the 2026-07-28 revision
// (server/discover, no handshake, no session) with a legacy initialize fallback. The tools act on
// the same store as REST, so an object created here reads back over /api/v3 unchanged.

import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the token\'s login.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the token\'s login.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(forge, name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of tool.inputSchema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }
  const repoOf = () => forge.repoFor(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (name) {
    case 'create_repo': {
      if (forge.repos.has(String(args.name))) return { result: toolError('Repository already exists') };
      const repo = forge.createRepo({
        name: String(args.name),
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return { result: toolResult(repoJson(forge, repo)) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (!repo) return { result: toolError('Repository not found') };
      return { result: toolResult(repoJson(forge, repo)) };
    }
    case 'list_repos': {
      const repos = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      return { result: toolResult(repos.map((repo) => repoJson(forge, repo))) };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (!repo) return { result: toolError('Repository not found') };
      const item = forge.createIssue(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return { result: toolResult(issueJson(forge, repo, item)) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (!repo) return { result: toolError('Repository not found') };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state !== 'all') items = items.filter((item) => item.state === state);
      items.sort((a, b) => a.number - b.number);
      return { result: toolResult(items.map((item) => issueJson(forge, repo, item))) };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (!repo) return { result: toolError('Repository not found') };
      const head = String(args.head);
      const base = String(args.base);
      if (!forge.branchTip(repo, head) || !forge.branchTip(repo, base)) {
        return { result: toolError('A head or base branch does not exist') };
      }
      const duplicate = [...repo.items.values()].find(
        (item) => item.kind === 'pull' && item.state === 'open' && item.head === head && item.base === base,
      );
      if (duplicate) return { result: toolError('A pull request already exists for this branch') };
      const item = forge.createPull(repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
      });
      return { result: toolResult(pullJson(forge, repo, item)) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (!repo) return { result: toolError('Repository not found') };
      const item = repo.items.get(Number(args.pull_number));
      if (!item || item.kind !== 'pull') return { result: toolError('Pull request not found') };
      if (item.merged || item.state !== 'open') return { result: toolError('Pull Request is not mergeable') };
      const merged = forge.mergePull(repo, item, 'squash');
      if (merged.conflict || merged.error) return { result: toolError('Pull Request is not mergeable') };
      return { result: toolResult(pullJson(forge, repo, item)) };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  }
}

function dispatch(forge, request) {
  const method = request.method;
  const params = request.params ?? {};
  switch (method) {
    case 'server/discover':
      return {
        result: {
          resultType: 'complete',
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return { result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    }
    case 'ping':
      return { result: {} };
    case 'tools/list':
      return { result: { tools: TOOLS } };
    case 'tools/call':
      return callTool(forge, String(params.name ?? ''), params.arguments ?? {});
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/**
 * Handle one POST /mcp body. Answers { status, value }: value null means an empty body
 * (a notification's 202). A body that is not JSON is a 400 with a -32700 parse error.
 */
export function handleMcp(forge, body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, value: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const runOne = (request) => {
    if (!request || typeof request !== 'object' || typeof request.method !== 'string') {
      return { status: 200, value: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
    }
    if (request.id === undefined) return { status: 202, value: null };
    const outcome = dispatch(forge, request);
    if (outcome.error) return { status: 200, value: { jsonrpc: '2.0', id: request.id, error: outcome.error } };
    return { status: 200, value: { jsonrpc: '2.0', id: request.id, result: outcome.result } };
  };
  if (Array.isArray(parsed)) {
    const answers = parsed.map(runOne).filter((answer) => answer.value !== null);
    if (answers.length === 0) return { status: 202, value: null };
    return { status: 200, value: answers.map((answer) => answer.value) };
  }
  return runOne(parsed);
}
