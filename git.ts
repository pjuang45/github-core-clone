// Git wire and object formats, implemented from the protocol itself on Node's standard library:
// SHA-1 object ids, pkt-line framing, commit/tree/tag codecs, packfile read/write with delta
// resolution, and reachability walks over an object lookup. No git binary is involved anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const OBJECT_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
export const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `data` stored as `type`: SHA-1 over "<type> <size>\0" + data. */
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function isOid(text) {
  return typeof text === 'string' && /^[0-9a-f]{40}$/.test(text);
}

// ---------------------------------------------------------------------------
// pkt-line framing: a 4-hex-digit length (counting itself) before each packet.
// 0000 is flush, 0001 delim, 0002 response-end, 0003 error.

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload) {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error(`pkt-line payload too large: ${body.length}`);
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

/** Encode a list of parts: strings/Buffers are data packets, 'flush' and 'delim' are control packets. */
export function encodePktLines(parts) {
  const out = [];
  for (const part of parts) {
    if (part === 'flush') out.push(PKT_FLUSH);
    else if (part === 'delim') out.push(PKT_DELIM);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/**
 * Decode every complete pkt-line in `buffer` from `offset`. Returns the packets and the offset of
 * the first unconsumed byte (a trailing packfile, or an incomplete packet, stays unconsumed).
 */
export function decodePktLines(buffer, offset = 0) {
  const packets = [];
  let pos = offset;
  while (pos + 4 <= buffer.length) {
    const head = buffer.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    if (length === 3) {
      packets.push({ kind: 'error' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, next: pos };
}

// ---------------------------------------------------------------------------
// Object codecs.

/** Parse a commit body into { tree, parents, author, committer, message }. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit = { tree: null, parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

/** Build a commit body. `author`/`committer` are full ident lines ("Name <email> ts +0000"). */
export function buildCommit({ tree, parents = [], author, committer, message }) {
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${author}\ncommitter ${committer}\n\n`;
  return Buffer.from(head + message, 'utf8');
}

export function makeIdent(name, email, timestampSec) {
  return `${name} <${email}> ${timestampSec} +0000`;
}

/**
 * Parse a tree body into entries { mode, name, oid }. Modes are the ASCII forms git writes
 * ('100644' for a file, '40000' for a directory).
 */
export function parseTree(data) {
  const entries = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** The sort key git uses inside a tree: a directory compares as if its name ended in '/'. */
function treeSortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree body from entries, sorted the way git sorts them. */
export function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse an annotated tag body into { object, type, tag, tagger, message }. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const tag = { object: null, type: null, tag: null, tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

/** The commit a tag object points at, following nested tags through `get`. */
export function peelTagToCommit(get, oid) {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
    if (!current) return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles.

/** Apply a git delta buffer to `base`, returning the result. */
export function applyDelta(base, delta) {
  let pos = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const targetSize = readVarint();
  const out = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      produced += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

/** Inflate the zlib stream starting at `offset`; reports the data and the offset just past it. */
function inflateAt(buffer, offset) {
  const result = inflateSync(buffer.subarray(offset), { info: true });
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a packfile into a Map of oid -> { type, data }, resolving ofs/ref deltas. `resolveExternal`
 * may supply base objects the pack does not carry (a thin pack); it answers { type, data } or null.
 */
export function readPack(buffer, resolveExternal = null) {
  if (buffer.length < 12 + 20) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const computed = sha1Hex(buffer.subarray(0, trailerStart));
  const trailer = buffer.subarray(trailerStart).toString('hex');
  if (computed !== trailer) throw new Error('pack checksum does not match its bytes');

  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = buffer[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry = { offset: entryOffset, typeCode, size, data: null, baseOffset: 0, baseOid: null };
    if (typeCode === 6) {
      let b = buffer[offset];
      offset += 1;
      let base = b & 0x7f;
      while (b & 0x80) {
        b = buffer[offset];
        offset += 1;
        base = ((base + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = entryOffset - base;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!OBJECT_TYPES[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) {
      throw new Error(`pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map();
  const resolvedByOid = new Map();
  const resolving = new Set();
  const resolve = (entry) => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type;
    let data;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (!baseEntry) throw new Error(`ofs-delta base at ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveExternal ? resolveExternal(entry.baseOid) : null;
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = OBJECT_TYPES[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data, oid };
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/** Encode one object's pack header (type/size varint). */
function writePackObjectHeader(type, size) {
  const code = TYPE_CODES[type];
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), with a valid SHA-1 trailer. */
export function writePack(objects) {
  const list = [...objects];
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// Reachability over an object lookup: get(oid) -> { type, data } | undefined.

/** Every object reachable from `tips` (commits walk parents, trees recurse, tags dereference). */
export function collectReachable(get, tips, { allowMissing = false } = {}) {
  const seen = new Set();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || seen.has(oid)) continue;
    const object = get(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.object) stack.push(tag.object);
    }
  }
  return seen;
}

/** The commit oids reachable from `tip` (the tip included), following parents only. */
export function commitAncestors(get, tip) {
  const seen = new Set();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || seen.has(oid)) continue;
    const object = get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(get, ancestor, descendant) {
  if (ancestor === descendant) return true;
  const seen = new Set();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (!oid || seen.has(oid)) continue;
    if (oid === ancestor) return true;
    seen.add(oid);
    const object = get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * A merge base of two commits: the common ancestor with the greatest generation, found by
 * breadth-first walk from both sides. Null when the histories share nothing.
 */
export function mergeBase(get, a, b) {
  if (a === b) return a;
  const ancestorsOfA = commitAncestors(get, a);
  if (ancestorsOfA.has(b)) return b;
  if (commitAncestors(get, b).has(a)) return a;
  const seen = new Set([b]);
  let frontier = [b];
  while (frontier.length > 0) {
    const next = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) return oid;
      const object = get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return null;
}
