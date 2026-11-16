// The REST v3 surface under /api/v3: repositories, branches, git refs, commits, contents,
// labels, issues, comments and pull requests. Every answer is JSON; errors are { message }.
// Handlers answer { status, value, headers? }; app.ts serializes and adds the request id.

import { parseCommit, parseTree } from './git.ts';
import { globalIdFor } from './store.ts';

function fail(status, message) {
  return { status, value: { message } };
}

function notFound() {
  return fail(404, 'Not Found');
}

/** Parse a JSON request body: an empty body is {}, malformed JSON is a 400. */
function jsonBody(body) {
  if (!body || body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value };
  } catch {
    return { ok: false, value: null };
  }
}

export function repoJson(forge, repo) {
  const login = forge.login ?? '';
  return {
    id: repo.id,
    node_id: globalIdFor('Repository', repo.id),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: forge.iso(repo.createdAt),
    updated_at: forge.iso(repo.updatedAt),
  };
}

export function issueJson(forge, repo, item) {
  return {
    id: item.id,
    node_id: globalIdFor('Issue', repo.id, item.number),
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    labels: item.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? '000000' })),
    user: { login: forge.login ?? '', id: 1 },
    comments: (repo.comments.get(item.number) ?? []).length,
    created_at: forge.iso(item.createdAt),
    updated_at: forge.iso(item.updatedAt),
  };
}

export function pullJson(forge, repo, item) {
  const login = forge.login ?? '';
  return {
    id: item.id,
    node_id: globalIdFor('PullRequest', repo.id, item.number),
    number: item.number,
    state: item.state,
    title: item.title,
    body: item.body,
    head: { ref: item.head, sha: forge.branchTip(repo, item.head), label: `${login}:${item.head}` },
    base: { ref: item.base, sha: forge.branchTip(repo, item.base), label: `${login}:${item.base}` },
    merged: item.merged,
    merged_at: item.mergedAt ? forge.iso(item.mergedAt) : null,
    merge_commit_sha: item.mergeCommitSha,
    user: { login, id: 1 },
    created_at: forge.iso(item.createdAt),
    updated_at: forge.iso(item.updatedAt),
  };
}

function commentJson(forge, comment) {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.login ?? '', id: 1 },
    created_at: forge.iso(comment.createdAt),
    updated_at: forge.iso(comment.createdAt),
  };
}

/** Normalize an issue/pull label list (strings or { name }) to names, or null on a bad shape. */
function labelNames(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return null;
  const names = [];
  for (const entry of input) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry.name === 'string') names.push(entry.name);
    else return null;
  }
  return names;
}

/** The first label name the repo does not hold, or null when every name exists. */
function unknownLabel(repo, names) {
  return names.find((name) => !repo.labels.has(name)) ?? null;
}

function identJson(line) {
  const match = /^(.*) <(.*)> (\d+) /.exec(line ?? '');
  if (!match) return { name: '', email: '', date: null };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

// ---------------------------------------------------------------------------

function userRepos(forge, method, query, headers, body) {
  if (method === 'POST') {
    const parsed = jsonBody(body);
    if (!parsed.ok) return fail(400, 'Malformed JSON');
    const { name, description } = parsed.value;
    if (typeof name !== 'string' || name === '') return fail(422, 'Repository name is required');
    if (forge.repos.has(name)) return fail(422, 'Repository already exists');
    const repo = forge.createRepo({
      name,
      isPrivate: parsed.value.private === true,
      description: typeof description === 'string' ? description : '',
    });
    return { status: 201, value: repoJson(forge, repo) };
  }
  if (method === 'GET') {
    const perPage = Math.max(1, Math.min(100, Number.parseInt(query.per_page ?? '30', 10) || 30));
    const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
    const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const response = { status: 200, value: slice.map((repo) => repoJson(forge, repo)) };
    if (page * perPage < all.length) {
      const host = headers.host ?? '127.0.0.1';
      const base = `http://${host}/api/v3/user/repos?per_page=${perPage}`;
      const last = Math.ceil(all.length / perPage);
      response.headers = {
        Link: `<${base}&page=${page + 1}>; rel="next", <${base}&page=${last}>; rel="last"`,
      };
    }
    return response;
  }
  return notFound();
}

function contentsRoute(forge, repo, method, segments, query, body) {
  const path = segments.join('/');
  if (method === 'GET') {
    const commitOid = forge.resolveRef(repo, query.ref);
    if (!commitOid) return notFound();
    const treeOid = forge.commitTreeOid(commitOid);
    if (!treeOid) return notFound();
    const dirJson = (entries, prefix) =>
      entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: prefix ? `${prefix}/${entry.name}` : entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : forge.get(entry.oid)?.data.length ?? 0,
      }));
    if (segments.length === 0) {
      const entries = forge.listPath(treeOid, []);
      return entries ? { status: 200, value: dirJson(entries, '') } : notFound();
    }
    const node = forge.lookupPath(treeOid, segments);
    if (!node) return notFound();
    if (node.isDir) {
      const entries = forge.listPath(treeOid, segments);
      return entries ? { status: 200, value: dirJson(entries, path) } : notFound();
    }
    const blob = forge.get(node.oid);
    if (!blob) return notFound();
    return {
      status: 200,
      value: {
        type: 'file',
        name: segments[segments.length - 1],
        path,
        sha: node.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }
  if (method === 'PUT') {
    const parsed = jsonBody(body);
    if (!parsed.ok) return fail(400, 'Malformed JSON');
    const content = Buffer.from(typeof parsed.value.content === 'string' ? parsed.value.content : '', 'base64');
    const result = forge.putContent(repo, {
      path,
      content,
      branch: typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined,
      sha: typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined,
      message: typeof parsed.value.message === 'string' ? parsed.value.message : undefined,
    });
    if (result.conflict) return fail(409, 'The sha does not match the current content');
    return {
      status: result.created ? 201 : 200,
      value: {
        content: {
          type: 'file',
          name: segments[segments.length - 1],
          path,
          sha: result.blobOid,
          size: content.length,
          encoding: 'base64',
        },
        commit: { sha: result.commitOid },
      },
    };
  }
  if (method === 'DELETE') {
    const parsed = jsonBody(body);
    if (!parsed.ok) return fail(400, 'Malformed JSON');
    const result = forge.deleteContent(repo, {
      path,
      branch: typeof parsed.value.branch === 'string' ? parsed.value.branch : undefined,
      sha: typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined,
      message: typeof parsed.value.message === 'string' ? parsed.value.message : undefined,
    });
    if (result.missing) return notFound();
    if (result.conflict) return fail(409, 'The sha does not match the current content');
    return { status: 200, value: { content: null, commit: { sha: result.commitOid } } };
  }
  return notFound();
}

function issuesRoute(forge, repo, method, segments, query, body) {
  if (segments.length === 0) {
    if (method === 'POST') {
      const parsed = jsonBody(body);
      if (!parsed.ok) return fail(400, 'Malformed JSON');
      const names = labelNames(parsed.value.labels);
      if (names === null) return fail(422, 'Labels must be names');
      const unknown = unknownLabel(repo, names);
      if (unknown) return fail(422, `Label "${unknown}" does not exist`);
      const item = forge.createIssue(repo, {
        title: typeof parsed.value.title === 'string' ? parsed.value.title : '',
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        labels: names,
      });
      return { status: 201, value: issueJson(forge, repo, item) };
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      const direction = query.direction ?? 'desc';
      let items = [...repo.items.values()].filter((item) => item.kind === 'issue');
      if (state !== 'all') items = items.filter((item) => item.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return { status: 200, value: items.map((item) => issueJson(forge, repo, item)) };
    }
    return notFound();
  }
  const number = Number.parseInt(segments[0], 10);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (segments.length === 1) {
    if (!item || item.kind !== 'issue') return notFound();
    if (method === 'GET') return { status: 200, value: issueJson(forge, repo, item) };
    if (method === 'PATCH') {
      const parsed = jsonBody(body);
      if (!parsed.ok) return fail(400, 'Malformed JSON');
      if (parsed.value.labels !== undefined) {
        const names = labelNames(parsed.value.labels);
        if (names === null) return fail(422, 'Labels must be names');
        const unknown = unknownLabel(repo, names);
        if (unknown) return fail(422, `Label "${unknown}" does not exist`);
        item.labels = names;
      }
      if (typeof parsed.value.title === 'string') item.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') item.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') item.state = parsed.value.state;
      item.updatedAt = forge.tick();
      return { status: 200, value: issueJson(forge, repo, item) };
    }
    return notFound();
  }
  if (segments.length === 2 && segments[1] === 'comments') {
    if (!item) return notFound();
    if (method === 'POST') {
      const parsed = jsonBody(body);
      if (!parsed.ok) return fail(400, 'Malformed JSON');
      const comment = forge.addComment(repo, item, typeof parsed.value.body === 'string' ? parsed.value.body : '');
      return { status: 201, value: commentJson(forge, comment) };
    }
    if (method === 'GET') {
      const comments = repo.comments.get(item.number) ?? [];
      return { status: 200, value: comments.map((comment) => commentJson(forge, comment)) };
    }
  }
  return notFound();
}

function pullsRoute(forge, repo, method, segments, query, body) {
  if (segments.length === 0) {
    if (method === 'POST') {
      const parsed = jsonBody(body);
      if (!parsed.ok) return fail(400, 'Malformed JSON');
      const head = parsed.value.head;
      const base = parsed.value.base;
      if (typeof head !== 'string' || typeof base !== 'string') return fail(422, 'A pull request needs a head and a base');
      if (!forge.branchTip(repo, head) || !forge.branchTip(repo, base)) {
        return fail(422, 'A head or base branch does not exist');
      }
      const duplicate = [...repo.items.values()].find(
        (item) => item.kind === 'pull' && item.state === 'open' && item.head === head && item.base === base,
      );
      if (duplicate) return fail(422, 'A pull request already exists for this branch');
      const item = forge.createPull(repo, {
        title: typeof parsed.value.title === 'string' ? parsed.value.title : '',
        body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
        head,
        base,
      });
      return { status: 201, value: pullJson(forge, repo, item) };
    }
    if (method === 'GET') {
      const state = query.state ?? 'open';
      let items = [...repo.items.values()].filter((item) => item.kind === 'pull');
      if (state !== 'all') items = items.filter((item) => item.state === state);
      items.sort((a, b) => b.number - a.number);
      return { status: 200, value: items.map((item) => pullJson(forge, repo, item)) };
    }
    return notFound();
  }
  const number = Number.parseInt(segments[0], 10);
  const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
  if (!item || item.kind !== 'pull') return notFound();
  if (segments.length === 1 && method === 'GET') return { status: 200, value: pullJson(forge, repo, item) };
  if (segments.length === 2 && segments[1] === 'files' && method === 'GET') {
    return { status: 200, value: forge.pullFiles(repo, item) };
  }
  if (segments.length === 2 && segments[1] === 'merge' && method === 'PUT') {
    const parsed = jsonBody(body);
    if (!parsed.ok) return fail(400, 'Malformed JSON');
    if (item.merged || item.state !== 'open') return fail(405, 'Pull Request is not mergeable');
    const method2 = typeof parsed.value.merge_method === 'string' ? parsed.value.merge_method : 'squash';
    const result = forge.mergePull(repo, item, method2);
    if (result.conflict) return fail(405, 'Pull Request is not mergeable');
    if (result.error) return fail(405, 'Pull Request is not mergeable');
    return { status: 200, value: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

function repoRoute(forge, method, segments, query, headers, body) {
  const owner = segments[1];
  const name = segments[2];
  const rest = segments.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') {
      const repo = forge.repoFor(owner, name);
      return repo ? { status: 200, value: repoJson(forge, repo) } : notFound();
    }
    if (method === 'PATCH') {
      const repo = forge.repoFor(owner, name);
      if (!repo) return notFound();
      const parsed = jsonBody(body);
      if (!parsed.ok) return fail(400, 'Malformed JSON');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      repo.updatedAt = forge.tick();
      return { status: 200, value: repoJson(forge, repo) };
    }
    if (method === 'DELETE') {
      return forge.deleteRepo(owner, name) ? { status: 204, value: null } : notFound();
    }
    return notFound();
  }
  const repo = forge.repoFor(owner, name);
  if (!repo) return notFound();

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      return { status: 200, value: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const tip = forge.branchTip(repo, branch);
      return tip ? { status: 200, value: { name: branch, commit: { sha: tip } } } : notFound();
    }
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([ref, oid]) => ({ ref, object: { sha: oid, type: forge.get(oid)?.type ?? 'commit' } }));
        return { status: 200, value: refs };
      }
      if (method === 'POST') {
        const parsed = jsonBody(body);
        if (!parsed.ok) return fail(400, 'Malformed JSON');
        const ref = parsed.value.ref;
        const sha = parsed.value.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) return fail(422, 'A ref must start with refs/');
        const object = typeof sha === 'string' ? forge.get(sha) : undefined;
        if (!object) return fail(422, 'The sha is not an object here');
        repo.refs.set(ref, sha);
        return { status: 201, value: { ref, object: { sha, type: object.type } } };
      }
      return notFound();
    }
    if (method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      return oid ? { status: 200, value: { ref, object: { sha: oid, type: forge.get(oid)?.type ?? 'commit' } } } : notFound();
    }
    return notFound();
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const start = query.sha ? forge.branchTip(repo, query.sha) ?? forge.resolveRef(repo, query.sha) : forge.branchTip(repo, repo.defaultBranch);
    if (!start) return { status: 200, value: [] };
    const commits = [];
    const seen = new Set();
    const stack = [start];
    while (stack.length > 0 && commits.length < 10_000) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = forge.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      commits.push({
        sha: oid,
        commit: {
          author: identJson(commit.author),
          committer: identJson(commit.committer),
          message: commit.message,
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      });
      for (const parent of [...commit.parents].reverse()) stack.push(parent);
    }
    return { status: 200, value: commits };
  }

  if (rest[0] === 'contents') return contentsRoute(forge, repo, method, rest.slice(1), query, body);

  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const parsed = jsonBody(body);
      if (!parsed.ok) return fail(400, 'Malformed JSON');
      const labelName = parsed.value.name;
      if (typeof labelName !== 'string' || labelName === '') return fail(422, 'A label needs a name');
      const existing = repo.labels.get(labelName);
      if (existing) return { status: 200, value: { name: existing.name, color: existing.color } };
      const label = { name: labelName, color: typeof parsed.value.color === 'string' ? parsed.value.color : '000000' };
      repo.labels.set(labelName, label);
      return { status: 201, value: { name: label.name, color: label.color } };
    }
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, value: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
    }
    return notFound();
  }

  if (rest[0] === 'issues') return issuesRoute(forge, repo, method, rest.slice(1), query, body);
  if (rest[0] === 'pulls') return pullsRoute(forge, repo, method, rest.slice(1), query, body);
  return notFound();
}

/**
 * Handle one /api/v3 request. `segments` are the decoded path segments after /api/v3.
 * Answers { status, value, headers? }; a null value serializes as an empty body.
 */
export function handleRest(forge, method, segments, query, headers, body) {
  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        value: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
        headers: { 'X-OAuth-Scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return { status: 200, value: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    if (!forge.login) return notFound();
    return { status: 200, value: { login: forge.login, id: 1, type: 'User' } };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    return userRepos(forge, method, query, headers, body);
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    return repoRoute(forge, method, segments, query, headers, body);
  }
  return notFound();
}
