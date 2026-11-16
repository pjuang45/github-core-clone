// The forge's state and the domain operations every surface shares: one object store, one
// repository table, and issues/pull requests/comments over it. REST, GraphQL, MCP and the git
// transport all read and write through here, so an object created on one surface is the same
// object on every other. Timestamps come from a logical clock so runs are reproducible.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  makeIdent,
  mergeBase,
  parseCommit,
  parseTree,
  peelTagToCommit,
  ZERO_OID,
} from './git.ts';

const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

export class Forge {
  constructor() {
    this.objects = new Map();
    this.repos = new Map();
    this.reposById = new Map();
    this.login = null;
    this.nextRepoId = 1;
    this.nextItemId = 1;
    this.nextCommentId = 1;
    this.clock = 1_735_689_600;
    this.requestSeq = 0;
  }

  /** Advance the logical clock and answer the new reading, in epoch seconds. */
  tick() {
    this.clock += 1;
    return this.clock;
  }

  iso(seconds) {
    return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // ------------------------------------------------------------- object store

  get(oid) {
    return this.objects.get(oid);
  }

  has(oid) {
    return this.objects.has(oid);
  }

  put(type, data) {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  storeObject(oid, object) {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }

  reachable(tips, options) {
    return collectReachable((oid) => this.objects.get(oid), tips, options);
  }

  commitTreeOid(commitOid) {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // ------------------------------------------------------------- login binding

  /**
   * The token's login is learned from the first owner-named request that reaches an existing
   * repository (the suite always works as the viewer first). Once bound, another owner never
   * matches. Answers whether `owner` is the bound login after this call.
   */
  bindOrMatch(owner) {
    if (!owner) return false;
    if (this.login === null) {
      this.login = owner;
      return true;
    }
    return this.login === owner;
  }

  ownerMatches(owner) {
    return this.login !== null && this.login === owner;
  }

  // ------------------------------------------------------------- repositories

  createRepo({ name, isPrivate = false, description = '' }) {
    if (this.repos.has(name)) return null;
    const repo = {
      id: this.nextRepoId,
      name,
      private: Boolean(isPrivate),
      description: description ?? '',
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
      comments: new Map(),
      createdAt: this.tick(),
      updatedAt: this.clock,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  /**
   * Look a repository up by owner/name the way every surface must: a missing name is null, and a
   * name that exists under another owner is also null (404, never 403). A successful lookup on an
   * unbound forge binds the login to `owner`.
   */
  repoFor(owner, name) {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.login === null) {
      this.login = owner;
      return repo;
    }
    return this.login === owner ? repo : null;
  }

  repoByName(name) {
    return this.repos.get(name) ?? null;
  }

  deleteRepo(owner, name) {
    const repo = this.repoFor(owner, name);
    if (!repo) return false;
    this.repos.delete(name);
    this.reposById.delete(repo.id);
    return true;
  }

  branchTip(repo, branch) {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  headTarget(repo) {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The ident server-made commits carry: the bound login, on the logical clock. */
  serverIdent() {
    const name = this.login ?? 'forge';
    return makeIdent(name, `${name}@forge.local`, this.tick());
  }

  /** Create a commit in the store from a tree, parents and message, as the server. */
  serverCommit(treeOid, parents, message) {
    const ident = this.serverIdent();
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    return this.put('commit', data);
  }

  // ------------------------------------------------------------- trees and paths

  /** Flatten a tree into a Map of path -> { mode, oid } for its files (directories recursed). */
  treeMap(treeOid) {
    const map = new Map();
    if (!treeOid) return map;
    const walk = (oid, prefix) => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else map.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return map;
  }

  /** Rebuild a tree (and its subtrees) from a flattened path map; answers the root tree oid. */
  buildTreeFromMap(map) {
    const build = (entries) => {
      const files = [];
      const dirs = new Map();
      for (const [path, leaf] of entries) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          files.push({ mode: leaf.mode, name: path, oid: leaf.oid });
        } else {
          const head = path.slice(0, slash);
          if (!dirs.has(head)) dirs.set(head, new Map());
          dirs.get(head).set(path.slice(slash + 1), leaf);
        }
      }
      const treeEntries = [...files];
      for (const [name, sub] of dirs) treeEntries.push({ mode: '40000', name, oid: build(sub) });
      return this.put('tree', buildTree(treeEntries));
    };
    return build(map);
  }

  /** The tree entry at `segments` under `treeOid`: { mode, oid, isDir } or null. */
  lookupPath(treeOid, segments) {
    let current = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) {
        return { mode: entry.mode, oid: entry.oid, isDir: entry.mode === '40000' };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The entries of the directory at `segments` under `treeOid`, or null when it is not a directory. */
  listPath(treeOid, segments) {
    let current = treeOid;
    if (segments.length === 0) {
      const object = this.objects.get(current);
      return object && object.type === 'tree' ? parseTree(object.data) : null;
    }
    const node = this.lookupPath(treeOid, segments);
    if (!node || !node.isDir) return null;
    const object = this.objects.get(node.oid);
    return object && object.type === 'tree' ? parseTree(object.data) : null;
  }

  /**
   * A new tree with `segments` set to `leaf` ({ mode, oid }) or removed (leaf null), built from
   * `treeOid` (which may be null for an empty tree). Intermediate directories are created.
   */
  setInTree(treeOid, segments, leaf) {
    const entries = treeOid ? parseTree(this.objects.get(treeOid).data) : [];
    const head = segments[0];
    const kept = entries.filter((entry) => entry.name !== head);
    if (segments.length === 1) {
      if (leaf) kept.push({ mode: leaf.mode, name: head, oid: leaf.oid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const childOid = this.setInTree(existing ? existing.oid : null, segments.slice(1), leaf);
      if (childOid !== EMPTY_TREE_OID || leaf) kept.push({ mode: '40000', name: head, oid: childOid });
    }
    return this.put('tree', buildTree(kept));
  }

  // ------------------------------------------------------------- contents

  /** Resolve a ref name (branch, tag, or raw commit oid) in a repo to a commit oid, or null. */
  resolveRef(repo, ref) {
    if (!ref) return this.branchTip(repo, repo.defaultBranch);
    const byBranch = repo.refs.get(`refs/heads/${ref}`);
    if (byBranch) return byBranch;
    const byTag = repo.refs.get(`refs/tags/${ref}`);
    if (byTag) return peelTagToCommit((oid) => this.objects.get(oid), byTag);
    if (/^[0-9a-f]{40}$/.test(ref) && this.objects.has(ref)) return ref;
    return null;
  }

  /**
   * Write a file through the contents API on `branch` (created from the default tip, or as a root
   * branch, when it does not exist). Answers { blobOid, commitOid, created } or { conflict: true }.
   */
  putContent(repo, { path, content, branch, sha, message }) {
    const branchName = branch || repo.defaultBranch;
    let tip = this.branchTip(repo, branchName);
    if (!tip && branchName !== repo.defaultBranch) tip = this.branchTip(repo, repo.defaultBranch);
    const treeOid = tip ? this.commitTreeOid(tip) : null;
    const segments = path.split('/');
    const existing = treeOid ? this.lookupPath(treeOid, segments) : null;
    if (sha !== undefined && sha !== null) {
      if (!existing || existing.isDir || existing.oid !== sha) return { conflict: true };
    }
    const blobOid = this.put('blob', content);
    const newTree = this.setInTree(treeOid, segments, { mode: '100644', oid: blobOid });
    const commitOid = this.serverCommit(newTree, tip ? [tip] : [], message ?? `Update ${path}`);
    repo.refs.set(`refs/heads/${branchName}`, commitOid);
    repo.updatedAt = this.clock;
    return { blobOid, commitOid, created: !existing };
  }

  /** Delete a file through the contents API. Answers { commitOid } or { missing } / { conflict }. */
  deleteContent(repo, { path, branch, sha, message }) {
    const branchName = branch || repo.defaultBranch;
    const tip = this.branchTip(repo, branchName);
    if (!tip) return { missing: true };
    const treeOid = this.commitTreeOid(tip);
    const segments = path.split('/');
    const existing = treeOid ? this.lookupPath(treeOid, segments) : null;
    if (!existing || existing.isDir) return { missing: true };
    if (sha !== undefined && sha !== null && existing.oid !== sha) return { conflict: true };
    const newTree = this.setInTree(treeOid, segments, null);
    const commitOid = this.serverCommit(newTree, [tip], message ?? `Delete ${path}`);
    repo.refs.set(`refs/heads/${branchName}`, commitOid);
    repo.updatedAt = this.clock;
    return { commitOid };
  }

  // ------------------------------------------------------------- issues and pulls

  createIssue(repo, { title, body = '', labels = [] }) {
    const item = {
      kind: 'issue',
      id: this.nextItemId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdAt: this.tick(),
      updatedAt: this.clock,
    };
    this.nextItemId += 1;
    repo.nextNumber += 1;
    repo.items.set(item.number, item);
    repo.comments.set(item.number, []);
    return item;
  }

  createPull(repo, { title, body = '', head, base }) {
    const item = {
      kind: 'pull',
      id: this.nextItemId,
      number: repo.nextNumber,
      title,
      body: body ?? '',
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: this.tick(),
      updatedAt: this.clock,
    };
    this.nextItemId += 1;
    repo.nextNumber += 1;
    repo.items.set(item.number, item);
    repo.comments.set(item.number, []);
    return item;
  }

  addComment(repo, item, body) {
    const comment = { id: this.nextCommentId, body, createdAt: this.tick() };
    this.nextCommentId += 1;
    if (!repo.comments.has(item.number)) repo.comments.set(item.number, []);
    repo.comments.get(item.number).push(comment);
    return comment;
  }

  // ------------------------------------------------------------- merging and diffs

  /** Three-way merge of flattened trees. Answers { map } or { conflicts: [paths] }. */
  mergeMaps(baseMap, oursMap, theirsMap) {
    const merged = new Map();
    const conflicts = [];
    const paths = new Set([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
    const same = (a, b) => a === b || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
    for (const path of paths) {
      const base = baseMap.get(path);
      const ours = oursMap.get(path);
      const theirs = theirsMap.get(path);
      if (same(ours, theirs)) {
        if (ours) merged.set(path, ours);
      } else if (same(base, ours)) {
        if (theirs) merged.set(path, theirs);
      } else if (same(base, theirs)) {
        if (ours) merged.set(path, ours);
      } else {
        conflicts.push(path);
      }
    }
    return conflicts.length > 0 ? { conflicts } : { map: merged };
  }

  /** The tree-level merge plan of head into base: { treeOid } or { conflicts }. */
  planMerge(repo, baseTip, headTip) {
    const get = (oid) => this.objects.get(oid);
    const base = mergeBase(get, baseTip, headTip);
    const baseMap = base ? this.treeMap(this.commitTreeOid(base)) : new Map();
    const oursMap = this.treeMap(this.commitTreeOid(baseTip));
    const theirsMap = this.treeMap(this.commitTreeOid(headTip));
    const result = this.mergeMaps(baseMap, oursMap, theirsMap);
    if (result.conflicts) return { conflicts: result.conflicts, mergeBase: base };
    return { treeOid: this.buildTreeFromMap(result.map), mergeBase: base };
  }

  /**
   * Merge a pull request. method 'merge' makes a two-parent merge commit; anything else squashes
   * to one commit on the base branch. Answers { sha }, { conflict: true }, or { error }.
   */
  mergePull(repo, pull, method) {
    if (pull.merged) return { error: 'already merged' };
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return { error: 'a branch is missing' };
    const plan = this.planMerge(repo, baseTip, headTip);
    if (plan.conflicts) return { conflict: true };
    let sha;
    if (method === 'merge') {
      sha = this.serverCommit(plan.treeOid, [baseTip, headTip], `Merge pull request #${pull.number} from ${pull.head}`);
    } else {
      sha = this.serverCommit(plan.treeOid, [baseTip], `${pull.title} (#${pull.number})`);
    }
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = this.tick();
    pull.mergeCommitSha = sha;
    pull.updatedAt = this.clock;
    repo.updatedAt = this.clock;
    return { sha };
  }

  /** True when head can merge into base without a conflict (the mergeable computation). */
  pullMergeable(repo, pull) {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!baseTip || !headTip) return 'UNKNOWN';
    const plan = this.planMerge(repo, baseTip, headTip);
    return plan.conflicts ? 'CONFLICTING' : 'MERGEABLE';
  }

  /** Line counts between two blob texts: additions/deletions after the common prefix/suffix. */
  lineDiff(oldText, newText) {
    const countLines = (text) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    if (oldText === null) return { additions: countLines(newText ?? ''), deletions: 0 };
    if (newText === null) return { additions: 0, deletions: countLines(oldText) };
    const a = oldText.split('\n');
    const b = newText.split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA -= 1;
      endB -= 1;
    }
    return { additions: endB - start, deletions: endA - start };
  }

  /** The changed files between two commits: [{ filename, status, additions, deletions, changes }]. */
  diffCommits(fromCommit, toCommit) {
    const fromMap = fromCommit ? this.treeMap(this.commitTreeOid(fromCommit)) : new Map();
    const toMap = toCommit ? this.treeMap(this.commitTreeOid(toCommit)) : new Map();
    const files = [];
    const paths = new Set([...fromMap.keys(), ...toMap.keys()]);
    for (const path of [...paths].sort()) {
      const from = fromMap.get(path);
      const to = toMap.get(path);
      if (from && to && from.oid === to.oid) continue;
      const oldText = from ? this.objects.get(from.oid)?.data.toString('utf8') ?? '' : null;
      const newText = to ? this.objects.get(to.oid)?.data.toString('utf8') ?? '' : null;
      const { additions, deletions } = this.lineDiff(oldText, newText);
      files.push({
        filename: path,
        status: !from ? 'added' : !to ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  /** The files a pull request changes: merge-base of head/base against the head tip. */
  pullFiles(repo, pull) {
    const baseTip = this.branchTip(repo, pull.base);
    const headTip = this.branchTip(repo, pull.head);
    if (!headTip) return [];
    const get = (oid) => this.objects.get(oid);
    const base = baseTip ? mergeBase(get, baseTip, headTip) : null;
    return this.diffCommits(base, headTip);
  }
}

export { EMPTY_TREE_OID, ZERO_OID };

/**
 * Relay-style global ids: base64 of "Type:key[:key...]". Opaque (never the plain database id or
 * issue number), stable across reads, and decodable by node(id:) and the mutation inputs.
 */
export function globalIdFor(type, ...keys) {
  return Buffer.from([type, ...keys].join(':'), 'utf8').toString('base64');
}

/** Decode a global id into { type, keys } or answer null when it is not one of ours. */
export function parseGlobalId(id) {
  if (typeof id !== 'string' || id === '') return null;
  let text;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2 || parts[0] === '') return null;
  return { type: parts[0], keys: parts.slice(1) };
}
