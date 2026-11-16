// Git smart HTTP: info/refs advertisements (upload-pack v2 and v0, receive-pack v0), the v2
// ls-refs and fetch commands, a v0 fetch fallback, and receive-pack pushes with per-ref
// report-status. Repositories are created over REST; a git URL for a missing repository is 404.

import {
  PKT_FLUSH,
  ZERO_OID,
  commitAncestors,
  decodePktLines,
  encodePktLines,
  isAncestor,
  parseCommit,
  parseTag,
  pktLine,
  readPack,
  writePack,
} from './git.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 =
  'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=' + AGENT;
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
/** Pack bytes per sideband packet: the packet stays under the 65520-byte framing limit. */
const SIDEBAND_CHUNK = 65_512;

function json(status, body) {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`) };
}

function text(status, body) {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(body) };
}

/** Wrap a byte stream in sideband band-1 pkt-lines (the packfile section / push report form). */
function sidebandWrap(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += SIDEBAND_CHUNK) {
    const chunk = bytes.subarray(offset, offset + SIDEBAND_CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (bytes.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The refs a repository advertises, sorted by name: [{ name, oid }]. */
function sortedRefs(repo) {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The commit an annotated tag peels to, or null for a lightweight tag / non-tag target. */
function peeledOf(forge, oid) {
  const object = forge.get(oid);
  if (!object || object.type !== 'tag') return null;
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const entry = forge.get(current);
    if (!entry) return null;
    if (entry.type === 'commit') return current === oid ? null : current;
    if (entry.type !== 'tag') return null;
    current = parseTag(entry.data).object;
  }
  return null;
}

function advertisementV0(forge, repo, service) {
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload ? `${UPLOAD_CAPS_V0} symref=HEAD:${forge.headTarget(repo)}` : RECEIVE_CAPS;
  const lines = [];
  const refs = sortedRefs(repo);
  if (isUpload) {
    const tip = forge.branchTip(repo, repo.defaultBranch);
    if (tip) lines.push(`${tip} HEAD`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      const peeled = peeledOf(forge, ref.oid);
      if (peeled) lines.push(`${peeled} ${ref.name}^{}`);
    }
  } else {
    for (const ref of refs) lines.push(`${ref.oid} ${ref.name}`);
  }
  if (lines.length === 0) lines.push(`${ZERO_OID} capabilities^{}`);
  const packets = [`# service=${service}\n`, 'flush'];
  lines.forEach((line, index) => {
    packets.push(index === 0 ? `${line}\0${caps}\n` : `${line}\n`);
  });
  packets.push('flush');
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: encodePktLines(packets),
  };
}

/** The v2 capability advertisement never changes, so it is encoded once. */
const ADVERTISEMENT_V2_BODY = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

function advertisementV2() {
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: ADVERTISEMENT_V2_BODY };
}

function infoRefs(forge, repo, service, headers) {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return text(400, 'unknown service');
  }
  const protocol = headers['git-protocol'] ?? '';
  if (service === 'git-upload-pack' && protocol.includes('version=2')) return advertisementV2();
  return advertisementV0(forge, repo, service);
}

// ---------------------------------------------------------------------------
// v2 commands

function parseV2Request(body) {
  const { packets } = decodePktLines(body);
  const command = [];
  const args = [];
  let section = command;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = args;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    section.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return { command, args };
}

function lsRefs(forge, repo, args) {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const target = forge.headTarget(repo);
  const tip = forge.branchTip(repo, repo.defaultBranch);
  if (matches('HEAD')) {
    if (tip) {
      lines.push(`${tip} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    } else {
      lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const peeled = peeledOf(forge, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: encodePktLines([...lines, 'flush']),
  };
}

/**
 * Compute the object set of a fetch: the closure of `wants` (depth-limited when `depth` is set)
 * minus everything the client already holds (the `haves` closure and the trees of its shallow
 * boundary commits). Also computes the shallow/unshallow lines the answer must carry.
 */
function planFetch(forge, { wants, haves, shallow, depth }) {
  const get = (oid) => forge.get(oid);
  const shallowSet = new Set(shallow);
  const excluded = new Set();
  for (const have of haves) {
    if (!forge.has(have)) continue;
    // A have that is also the client's shallow boundary is held without its parents: exclude the
    // commit and its tree, but never its ancestry (deepening exists to deliver exactly that).
    if (shallowSet.has(have)) {
      excluded.add(have);
      const tree = forge.commitTreeOid(have);
      if (tree) for (const oid of forge.reachable([tree], { allowMissing: true })) excluded.add(oid);
      continue;
    }
    for (const oid of forge.reachable([have], { allowMissing: true })) excluded.add(oid);
  }
  for (const boundary of shallow) {
    if (!forge.has(boundary)) continue;
    excluded.add(boundary);
    const tree = forge.commitTreeOid(boundary);
    if (tree) for (const oid of forge.reachable([tree], { allowMissing: true })) excluded.add(oid);
  }
  const knownCommits = new Set(shallow);
  for (const have of haves) {
    if (!forge.has(have) || shallowSet.has(have)) continue;
    for (const oid of commitAncestors(get, have)) knownCommits.add(oid);
  }
  const parentsOf = (oid) => {
    const object = forge.get(oid);
    return object && object.type === 'commit' ? parseCommit(object.data).parents : [];
  };

  const allowed = new Set();
  if (depth !== null && depth !== undefined) {
    let frontier = [...wants];
    const seenCommits = new Set();
    for (let generation = 0; generation < depth && frontier.length > 0; generation += 1) {
      const next = [];
      for (const commitOid of frontier) {
        if (seenCommits.has(commitOid)) continue;
        seenCommits.add(commitOid);
        allowed.add(commitOid);
        const tree = forge.commitTreeOid(commitOid);
        if (tree) for (const oid of forge.reachable([tree], { allowMissing: true })) allowed.add(oid);
        for (const parent of parentsOf(commitOid)) next.push(parent);
      }
      frontier = next;
    }
  } else {
    for (const oid of forge.reachable(wants, { allowMissing: true })) allowed.add(oid);
  }

  const send = [...allowed].filter((oid) => !excluded.has(oid));
  const sentCommits = new Set(send.filter((oid) => forge.get(oid)?.type === 'commit'));
  const shallowLines = [];
  const unshallowLines = [];
  for (const commitOid of sentCommits) {
    const parents = parentsOf(commitOid);
    if (parents.length > 0 && parents.some((parent) => !sentCommits.has(parent) && !knownCommits.has(parent))) {
      shallowLines.push(commitOid);
    }
  }
  for (const boundary of shallow) {
    const parents = parentsOf(boundary);
    if (parents.length > 0 && parents.every((parent) => sentCommits.has(parent) || knownCommits.has(parent))) {
      unshallowLines.push(boundary);
    }
  }
  return { send, shallowLines, unshallowLines };
}

function fetchPack(forge, plan) {
  const objects = plan.send.map((oid) => forge.get(oid)).filter(Boolean);
  return writePack(objects);
}

function fetchV2(forge, repo, args) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  let done = false;
  for (const line of args) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') done = true;
  }
  if (wants.length === 0) return text(400, 'fetch needs a want');
  for (const want of wants) if (!forge.has(want)) return text(400, `want ${want} is not an object here`);
  const plan = planFetch(forge, { wants, haves, shallow, depth });
  const pack = fetchPack(forge, plan);
  const packets = [];
  if (!done) {
    packets.push('acknowledgments\n');
    const common = haves.filter((have) => forge.has(have));
    if (common.length === 0) packets.push('NAK\n');
    else {
      for (const have of common) packets.push(`ACK ${have}\n`);
      packets.push('ready\n');
    }
    packets.push('flush');
  }
  if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
    packets.push('shallow-info\n');
    for (const oid of plan.shallowLines) packets.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallowLines) packets.push(`unshallow ${oid}\n`);
    packets.push('flush');
  }
  const body = Buffer.concat([
    encodePktLines(packets),
    pktLine('packfile\n'),
    sidebandWrap(pack),
  ]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function fetchV0(forge, repo, body) {
  const { packets } = decodePktLines(body);
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.split(' ')[1]);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  if (wants.length === 0) return text(400, 'fetch needs a want');
  for (const want of wants) if (!forge.has(want)) return text(400, `want ${want} is not an object here`);
  const plan = planFetch(forge, { wants, haves, shallow, depth });
  const pack = fetchPack(forge, plan);
  const lines = [];
  for (const oid of plan.shallowLines) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallowLines) lines.push(`unshallow ${oid}\n`);
  lines.push('NAK\n');
  const bodyOut = Buffer.concat([encodePktLines(lines), sidebandWrap(pack)]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: bodyOut };
}

function uploadPack(forge, repo, headers, body) {
  const protocol = headers['git-protocol'] ?? '';
  try {
    if (protocol.includes('version=2')) {
      const { command, args } = parseV2Request(body);
      const name = command.find((line) => line.startsWith('command='))?.slice('command='.length);
      if (name === 'ls-refs') return lsRefs(forge, repo, args);
      if (name === 'fetch') return fetchV2(forge, repo, args);
      return text(400, `unknown command ${name ?? ''}`);
    }
    return fetchV0(forge, repo, body);
  } catch {
    return text(400, 'malformed upload-pack request');
  }
}

// ---------------------------------------------------------------------------
// receive-pack

function receivePack(forge, repo, body) {
  let commands = [];
  let capabilities = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, next } = decodePktLines(body);
    packBytes = body.subarray(next);
    let first = true;
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (first) {
        first = false;
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
          line = line.slice(0, nul);
        }
      }
      const parts = line.split(' ');
      if (parts.length >= 3) commands.push({ old: parts[0], next: parts[1], ref: parts.slice(2).join(' ') });
    }
  } catch {
    return text(400, 'malformed receive-pack request');
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => forge.get(oid));
      for (const [oid, object] of objects) forge.storeObject(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  const get = (oid) => forge.get(oid);
  const reports = [];
  for (const command of commands) {
    const fail = (reason) => reports.push({ ref: command.ref, ok: false, reason });
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.old !== current) {
      fail('stale info');
      continue;
    }
    if (command.next === ZERO_OID) {
      if (current !== ZERO_OID && command.ref === forge.headTarget(repo)) {
        fail('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true });
      continue;
    }
    const object = forge.get(command.next);
    if (!object) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) {
      if (object.type !== 'commit') {
        fail('not a commit');
        continue;
      }
      if (current !== ZERO_OID && !isAncestor(get, current, command.next)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.next);
    reports.push({ ref: command.ref, ok: true });
  }
  if (commands.length > 0) repo.updatedAt = forge.clock;

  const lines = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const report of reports) {
    lines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const reportStream = encodePktLines([...lines, 'flush']);
  const useSideband = capabilities.includes('side-band-64k');
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: useSideband ? sidebandWrap(reportStream) : reportStream,
  };
}

// ---------------------------------------------------------------------------
// routing

/**
 * Handle one git smart-HTTP request. `segments` are the decoded path segments
 * ([owner, "<repo>.git", ...rest]) and `query` the parsed query parameters.
 * Answers null when the path is not a git path at all.
 */
export function handleGit(forge, method, segments, query, headers, body) {
  if (segments.length < 2 || !segments[1].endsWith('.git')) return null;
  const owner = segments[0];
  const name = segments[1].slice(0, -4);
  const repo = forge.repoFor(owner, name);
  if (!repo) return json(404, { message: 'Not Found' });
  const rest = segments.slice(2);
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    return infoRefs(forge, repo, query.service ?? '', headers);
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    return uploadPack(forge, repo, headers, body);
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    return receivePack(forge, repo, body);
  }
  return json(404, { message: 'Not Found' });
}
