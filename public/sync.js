// Merge changes against the last confirmed server snapshot. Never silently resolve
// two edits to the same field, or a deletion against an edit.
export const sameState = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function mergeStates(base, local, remote, prefer = 'local') {
  const conflicts = [];
  const visit = (before, mine, theirs, path, field) => {
    if (sameState(mine, theirs)) return copy(mine);
    if (sameState(mine, before)) return copy(theirs);
    if (sameState(theirs, before)) return copy(mine);
    if (object(mine) && object(theirs) && (object(before) || before === undefined)) {
      const out = Object.create(null), conflictStart = conflicts.length;
      for (const key of new Set([...Object.keys(before || {}), ...Object.keys(theirs), ...Object.keys(mine)])) {
        const value = visit(before?.[key], mine[key], theirs[key], path ? path + '.' + key : key, key);
        if (value !== undefined) out[key] = value;
      }
      // Totals and shares form one financial record. If field-level merging
      // would break it, require a choice of the whole valid bill instead.
      if (field === 'items' && Array.isArray(out.shares)) {
        const sum = out.shares.reduce((n, share) => n + Math.round(share.a * 100), 0);
        const valid = out.shares.length > 0 && out.shares.every((share) => Number.isFinite(share.a) && share.a > 0 && Number.isFinite(share.pd) && share.pd >= 0 && share.pd <= share.a + 0.005) && Math.abs(sum - Math.round(out.a * 100)) <= 1;
        if (!valid) {
          conflicts.splice(conflictStart); conflicts.push({ path, local: copy(mine), remote: copy(theirs) });
          return copy(prefer === 'remote' ? theirs : mine);
        }
      }
      return out;
    }
    if (Array.isArray(mine) && Array.isArray(theirs) && (Array.isArray(before) || before === undefined)) {
      const keyFor = ['cards', 'plans', 'items'].includes(field) ? (entry) => entry.id :
        field === 'months' ? (entry) => (entry.cardId || 'card-default') + ':' + entry.ym :
        field === 'shares' ? (entry) => entry.p.trim().toLowerCase() :
        ['people', 'inactivePeople'].includes(field) ? (entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : undefined : null;
      if (keyFor) {
        const indexed = [before || [], mine, theirs].map((rows) => {
          const map = new Map();
          for (const row of rows) { const key = keyFor(row); if (!key || map.has(key)) return null; map.set(key, row); }
          return map;
        });
        if (indexed.every(Boolean)) {
          const [b, l, r] = indexed, out = [];
          for (const key of new Set([...r.keys(), ...l.keys(), ...b.keys()])) {
            const value = visit(b.get(key), l.get(key), r.get(key), path + '[' + key + ']', field);
            if (value !== undefined) out.push(value);
          }
          return out;
        }
      }
    }
    conflicts.push({ path, local: copy(mine), remote: copy(theirs) });
    return copy(prefer === 'remote' ? theirs : mine);
  };
  return { data: copy(visit(base, local, remote, '', '')), conflicts };
}
