// The GraphQL v4 surface at /api/graphql: a small lexer/parser for the documents gh and
// github-mcp-server send, a schema model that answers __type introspection and field validation,
// and resolvers over the same store REST uses. Batched operations (a JSON array body) answer one
// result per operation, in order. An unknown field is a 200 with an errors array naming it.

import { globalIdFor, parseGlobalId } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer

function tokenize(source) {
  const tokens = [];
  let pos = 0;
  const isNameStart = (c) => /[_A-Za-z]/.test(c);
  const isNameChar = (c) => /[_0-9A-Za-z]/.test(c);
  while (pos < source.length) {
    const c = source[pos];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      pos += 1;
      continue;
    }
    if (c === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (source.startsWith('...', pos)) {
      tokens.push({ kind: 'spread' });
      pos += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      pos += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', pos)) {
        const end = source.indexOf('"""', pos + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(pos + 3, end) });
        pos = end + 3;
        continue;
      }
      let value = '';
      pos += 1;
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') {
          const esc = source[pos + 1];
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(pos + 2, pos + 6), 16));
            pos += 6;
          } else if (map[esc] !== undefined) {
            value += map[esc];
            pos += 2;
          } else {
            throw new Error(`bad string escape \\${esc}`);
          }
        } else {
          value += source[pos];
          pos += 1;
        }
      }
      if (pos >= source.length) throw new Error('unterminated string');
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[-0-9]/.test(c)) {
      const match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(pos));
      if (!match) throw new Error(`bad number at ${pos}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: Number(text) });
      pos += text.length;
      continue;
    }
    if (isNameStart(c)) {
      let end = pos + 1;
      while (end < source.length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${pos}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  expectPunct(value) {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  skipPunct(value) {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expectName() {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument() {
    const operations = [];
    const fragments = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variableDefinitions: {}, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value;
        let name = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const variableDefinitions = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : {};
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        operations.push({ operation, name, variableDefinitions, selectionSet });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected on in fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments[fragName] = { typeCondition, selectionSet: this.parseSelectionSet() };
      } else {
        throw new Error('unexpected token in document');
      }
    }
    return { operations, fragments };
  }

  parseVariableDefinitions() {
    const defs = {};
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue;
      if (this.skipPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      defs[name] = { defaultValue };
    }
    return defs;
  }

  parseType() {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  skipDirectives() {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseArguments() {
    const args = {};
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    return args;
  }

  parseValue() {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = {};
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value token');
  }

  parseSelectionSet() {
    const selections = [];
    this.expectPunct('{');
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
      } else {
        let name = this.expectName();
        let alias = null;
        if (this.skipPunct(':')) {
          alias = name;
          name = this.expectName();
        }
        const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : {};
        this.skipDirectives();
        const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
        selections.push({ kind: 'field', alias, name, args, selectionSet });
      }
    }
    return selections;
  }
}

function resolveValue(node, variables) {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Schema model (introspection + validation)

const TYPE_FIELDS = {
  Query: ['viewer', 'repository', 'node', 'user', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'state', 'merged', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'createdAt', 'updatedAt', 'url', 'additions', 'deletions', 'changedFiles', 'mergedAt',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'authoredDate'],
  Label: ['name', 'color'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Node: ['id'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_VALUES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

function typeObject(name) {
  if (ENUM_VALUES[name]) {
    return { __typename: '__Type', name, kind: 'ENUM', fieldNames: null, enumNames: ENUM_VALUES[name] };
  }
  if (TYPE_FIELDS[name]) {
    return { __typename: '__Type', name, kind: name === 'Node' ? 'INTERFACE' : 'OBJECT', fieldNames: TYPE_FIELDS[name], enumNames: null };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Object wrappers over the store

const userObj = () => ({ __typename: 'User' });
const repoObj = (repo) => ({ __typename: 'Repository', repo });
const issueObj = (repo, item) => ({ __typename: 'Issue', repo, item });
const pullObj = (repo, item) => ({ __typename: 'PullRequest', repo, item });
const commentObj = (repo, item, comment) => ({ __typename: 'IssueComment', repo, item, comment });

function cursorOf(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function connection(typename, edgeTypename, entries, args) {
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = entries.findIndex((entry) => cursorOf(entry.item.number) === args.after);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : entries.length;
  const slice = entries.slice(start, start + first);
  return {
    __typename: typename,
    nodes: slice.map((entry) => entry.node),
    edges: slice.map((entry) => ({ __typename: edgeTypename, node: entry.node, cursor: cursorOf(entry.item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + slice.length < entries.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? cursorOf(slice[0].item.number) : null,
      endCursor: slice.length > 0 ? cursorOf(slice[slice.length - 1].item.number) : null,
    },
    totalCount: entries.length,
  };
}

// ---------------------------------------------------------------------------
// Resolvers

function resolveQuery(ctx, field, args) {
  const { forge } = ctx;
  switch (field) {
    case 'viewer':
      return userObj();
    case 'repository': {
      const repo = forge.repoFor(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? repoObj(repo) : null;
    }
    case 'user':
      return args.login === forge.login ? userObj() : null;
    case 'node': {
      const parsed = parseGlobalId(args.id);
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = forge.reposById.get(Number(parsed.keys[0]));
        return repo ? repoObj(repo) : null;
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const repo = forge.reposById.get(Number(parsed.keys[0]));
        const item = repo?.items.get(Number(parsed.keys[1]));
        if (!item) return null;
        if (parsed.type === 'Issue' && item.kind === 'issue') return issueObj(repo, item);
        if (parsed.type === 'PullRequest' && item.kind === 'pull') return pullObj(repo, item);
        return null;
      }
      if (parsed.type === 'User') return userObj();
      return null;
    }
    case '__type':
      return typeObject(String(args.name ?? ''));
    case '__schema':
      return { __typename: '__Schema' };
    case 'search':
      return null;
    default:
      return null;
  }
}

function payloadIssue(ctx, repo, item) {
  return issueObj(repo, item);
}

function resolveMutation(ctx, field, args) {
  const { forge } = ctx;
  const input = args.input ?? {};
  const repoFromId = (id) => {
    const parsed = parseGlobalId(id);
    if (!parsed || parsed.type !== 'Repository') return null;
    return forge.reposById.get(Number(parsed.keys[0])) ?? null;
  };
  const itemFromId = (id) => {
    const parsed = parseGlobalId(id);
    if (!parsed) return null;
    const repo = forge.reposById.get(Number(parsed.keys[0]));
    const item = repo?.items.get(Number(parsed.keys[1]));
    return repo && item ? { repo, item } : null;
  };
  switch (field) {
    case 'createIssue': {
      const repo = repoFromId(input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'createIssue names a repository that does not exist' });
        return null;
      }
      const item = forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { __typename: 'CreateIssuePayload', issue: payloadIssue(ctx, repo, item), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const found = itemFromId(input.issueId);
      if (!found || found.item.kind !== 'issue') {
        ctx.errors.push({ message: `${field} names an issue that does not exist` });
        return null;
      }
      found.item.state = field === 'closeIssue' ? 'closed' : 'open';
      found.item.updatedAt = forge.tick();
      return {
        __typename: field === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload',
        issue: payloadIssue(ctx, found.repo, found.item),
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    case 'createPullRequest': {
      const repo = repoFromId(input.repositoryId);
      if (!repo) {
        ctx.errors.push({ message: 'createPullRequest names a repository that does not exist' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!forge.branchTip(repo, head) || !forge.branchTip(repo, base)) {
        ctx.errors.push({ message: 'createPullRequest names a branch that does not exist' });
        return null;
      }
      const duplicate = [...repo.items.values()].find(
        (item) => item.kind === 'pull' && item.state === 'open' && item.head === head && item.base === base,
      );
      if (duplicate) {
        ctx.errors.push({ message: 'A pull request already exists for this branch' });
        return null;
      }
      const item = forge.createPull(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), head, base });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, item), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const found = itemFromId(input.pullRequestId);
      if (!found || found.item.kind !== 'pull') {
        ctx.errors.push({ message: 'mergePullRequest names a pull request that does not exist' });
        return null;
      }
      const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
      const result = forge.mergePull(found.repo, found.item, method === 'merge' ? 'merge' : 'squash');
      if (result.conflict || result.error) {
        ctx.errors.push({ message: 'Pull Request is not mergeable' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.item), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const found = itemFromId(input.subjectId);
      if (!found) {
        ctx.errors.push({ message: 'addComment names a subject that does not exist' });
        return null;
      }
      const comment = forge.addComment(found.repo, found.item, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentObj(found.repo, found.item, comment), cursor: cursorOf(found.item.number) },
        subject: found.item.kind === 'issue' ? issueObj(found.repo, found.item) : pullObj(found.repo, found.item),
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    default:
      return null;
  }
}

function resolveRepository(ctx, source, field, args) {
  const { forge } = ctx;
  const repo = source.repo;
  switch (field) {
    case 'id':
      return globalIdFor('Repository', repo.id);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${forge.login ?? ''}/${repo.name}`;
    case 'owner':
      return userObj();
    case 'defaultBranchRef': {
      const tip = forge.branchTip(repo, repo.defaultBranch);
      return tip ? { __typename: 'Ref', name: repo.defaultBranch, repo } : null;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.private;
    case 'createdAt':
      return forge.iso(repo.createdAt);
    case 'updatedAt':
      return forge.iso(repo.updatedAt);
    case 'url':
      return '';
    case 'issue': {
      const item = repo.items.get(Number(args.number));
      return item && item.kind === 'issue' ? issueObj(repo, item) : null;
    }
    case 'issues': {
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
        items = items.filter((item) => wanted.has(item.state));
      }
      const direction = args.orderBy?.direction === 'ASC' ? 1 : -1;
      const ordered = [...items].sort((a, b) => (a.number - b.number) * (args.orderBy ? direction : 1));
      if (!args.orderBy) ordered.sort((a, b) => a.number - b.number);
      return connection('IssueConnection', 'IssueEdge', ordered.map((item) => ({ item, node: issueObj(repo, item) })), args);
    }
    case 'pullRequest': {
      const item = repo.items.get(Number(args.number));
      return item && item.kind === 'pull' ? pullObj(repo, item) : null;
    }
    case 'pullRequests': {
      let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state)));
        items = items.filter((item) => {
          const state = item.merged ? 'MERGED' : item.state.toUpperCase();
          return wanted.has(state);
        });
      }
      const ordered = [...items].sort((a, b) => a.number - b.number);
      return connection('PullRequestConnection', 'PullRequestEdge', ordered.map((item) => ({ item, node: pullObj(repo, item) })), args);
    }
    default:
      return null;
  }
}

function resolveIssue(ctx, source, field) {
  const { forge } = ctx;
  const { repo, item } = source;
  switch (field) {
    case 'id':
      return globalIdFor('Issue', repo.id, item.number);
    case 'number':
      return item.number;
    case 'title':
      return item.title;
    case 'state':
      return item.state.toUpperCase();
    case 'body':
      return item.body;
    case 'author':
      return userObj();
    case 'repository':
      return repoObj(repo);
    case 'createdAt':
      return forge.iso(item.createdAt);
    case 'updatedAt':
      return forge.iso(item.updatedAt);
    case 'url':
      return '';
    case 'labels':
      return {
        __typename: 'LabelConnection',
        nodes: item.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? '000000' })),
        edges: [],
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: item.labels.length,
      };
    case 'comments': {
      const comments = repo.comments.get(item.number) ?? [];
      return {
        __typename: 'IssueCommentConnection',
        nodes: comments.map((comment) => commentObj(repo, item, comment)),
        edges: [],
        pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: comments.length,
      };
    }
    default:
      return null;
  }
}

function resolvePull(ctx, source, field, args) {
  const { forge } = ctx;
  const { repo, item } = source;
  switch (field) {
    case 'id':
      return globalIdFor('PullRequest', repo.id, item.number);
    case 'number':
      return item.number;
    case 'state':
      return item.merged ? 'MERGED' : item.state.toUpperCase();
    case 'merged':
      return item.merged;
    case 'title':
      return item.title;
    case 'body':
      return item.body;
    case 'headRefName':
      return item.head;
    case 'baseRefName':
      return item.base;
    case 'mergeable':
      return item.merged || item.state !== 'open' ? 'UNKNOWN' : forge.pullMergeable(repo, item);
    case 'author':
      return userObj();
    case 'createdAt':
      return forge.iso(item.createdAt);
    case 'updatedAt':
      return forge.iso(item.updatedAt);
    case 'mergedAt':
      return item.mergedAt ? forge.iso(item.mergedAt) : null;
    case 'url':
      return '';
    case 'files': {
      const files = forge.pullFiles(repo, item);
      const first = typeof args.first === 'number' ? Math.max(0, args.first) : files.length;
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.slice(0, first).map((file) => ({
          __typename: 'PullRequestChangedFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        })),
        edges: [],
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
        totalCount: files.length,
      };
    }
    case 'additions':
      return forge.pullFiles(repo, item).reduce((sum, file) => sum + file.additions, 0);
    case 'deletions':
      return forge.pullFiles(repo, item).reduce((sum, file) => sum + file.deletions, 0);
    case 'changedFiles':
      return forge.pullFiles(repo, item).length;
    default:
      return null;
  }
}

function resolveField(ctx, typename, source, field, args) {
  const { forge } = ctx;
  switch (typename) {
    case 'Query':
      return resolveQuery(ctx, field, args);
    case 'Mutation':
      return resolveMutation(ctx, field, args);
    case 'User':
      if (field === 'login') return forge.login ?? '';
      if (field === 'id') return globalIdFor('User', 1);
      if (field === 'databaseId') return 1;
      if (field === 'name') return forge.login ?? '';
      return '';
    case 'Repository':
      return resolveRepository(ctx, source, field, args);
    case 'Issue':
      return resolveIssue(ctx, source, field);
    case 'PullRequest':
      return resolvePull(ctx, source, field, args);
    case 'Ref':
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      if (field === 'target') {
        const tip = forge.branchTip(source.repo, source.name);
        return tip ? { __typename: 'Commit', oid: tip } : null;
      }
      return null;
    case 'Commit':
      if (field === 'oid') return source.oid;
      return null;
    case 'Label':
      return source[field] ?? null;
    case 'IssueComment':
      if (field === 'id') return globalIdFor('Comment', source.repo.id, source.item.number, source.comment.id);
      if (field === 'body') return source.comment.body;
      if (field === 'author') return userObj();
      if (field === 'createdAt' || field === 'updatedAt') return forge.iso(source.comment.createdAt);
      return null;
    case '__Type':
      if (field === 'name') return source.name;
      if (field === 'kind') return source.kind;
      if (field === 'description') return null;
      if (field === 'fields') return (source.fieldNames ?? []).map((name) => ({ __typename: '__Field', name }));
      if (field === 'enumValues') return (source.enumNames ?? []).map((name) => ({ __typename: '__EnumValue', name }));
      if (field === 'possibleTypes') return [];
      if (field === 'inputFields') return [];
      if (field === 'ofType') return null;
      return null;
    case '__Field':
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return null;
    case '__EnumValue':
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return null;
    case '__Schema':
      if (field === 'queryType') return typeObject('Query');
      if (field === 'mutationType') return typeObject('Mutation');
      if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => typeObject(name)).filter(Boolean);
      if (field === 'directives') return [];
      return null;
    default:
      if (source && typeof source === 'object' && field in source && !field.startsWith('__')) {
        const value = source[field];
        return value === undefined ? null : value;
      }
      return null;
  }
}

// ---------------------------------------------------------------------------
// Execution

function executeSelectionSet(ctx, typename, source, selections, out) {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const key = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        out[key] = typename;
        continue;
      }
      const known = TYPE_FIELDS[typename];
      if (!known || !known.includes(selection.name)) {
        ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typename}'` });
        out[key] = null;
        continue;
      }
      const args = {};
      for (const [argName, argNode] of Object.entries(selection.args)) {
        args[argName] = resolveValue(argNode, ctx.variables);
      }
      const value = resolveField(ctx, typename, source, selection.name, args);
      out[key] = completeValue(ctx, value, selection.selectionSet);
    } else if (selection.kind === 'inlineFragment') {
      if (fragmentApplies(selection.typeCondition, typename)) {
        executeSelectionSet(ctx, typename, source, selection.selectionSet, out);
      }
    } else if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments[selection.name];
      if (fragment && fragmentApplies(fragment.typeCondition, typename)) {
        executeSelectionSet(ctx, typename, source, fragment.selectionSet, out);
      }
    }
  }
}

function fragmentApplies(typeCondition, typename) {
  if (!typeCondition) return true;
  if (typeCondition === typename) return true;
  if (typeCondition === 'Node' && NODE_TYPES.has(typename)) return true;
  return false;
}

function completeValue(ctx, value, selectionSet) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => completeValue(ctx, entry, selectionSet));
  if (typeof value === 'object' && value.__typename) {
    if (!selectionSet) return {};
    const out = {};
    executeSelectionSet(ctx, value.__typename, value, selectionSet, out);
    return out;
  }
  return value;
}

function executeOperation(forge, document, operation, variables) {
  const errors = [];
  const vars = { ...(variables ?? {}) };
  for (const [name, def] of Object.entries(operation.variableDefinitions)) {
    if (vars[name] === undefined && def.defaultValue !== undefined) {
      vars[name] = resolveValue(def.defaultValue, vars);
    }
  }
  const ctx = { forge, variables: vars, errors, fragments: document.fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = {};
  executeSelectionSet(ctx, rootType, {}, operation.selectionSet, data);
  const response = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

/**
 * Handle one POST /api/graphql body. Answers { status, value }: a single operation object, or an
 * array of them for a batched request. GraphQL-level failures are 200 with an errors array.
 */
export function handleGraphQL(forge, body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { status: 400, value: { errors: [{ message: 'The request body is not valid JSON' }] } };
  }
  const runOne = (entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.query !== 'string') {
      return { errors: [{ message: 'A GraphQL request needs a query string' }] };
    }
    let document;
    try {
      document = new Parser(tokenize(entry.query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
    }
    let operation = document.operations[0];
    if (typeof entry.operationName === 'string') {
      operation = document.operations.find((candidate) => candidate.name === entry.operationName) ?? operation;
    } else if (document.operations.length > 1) {
      operation = document.operations.find((candidate) => candidate.operation === 'query') ?? operation;
    }
    if (!operation) return { data: null, errors: [{ message: 'No operation in the document' }] };
    return executeOperation(forge, document, operation, entry.variables ?? {});
  };
  if (Array.isArray(parsed)) return { status: 200, value: parsed.map(runOne) };
  return { status: 200, value: runOne(parsed) };
}
