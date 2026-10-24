// Diff two `modified` maps (plan §5 配置页): what would change if the YAML in
// the configuration drawer were applied? Only top-level option keys are
// compared; map values are sparse patches, so `{ AfterClass: true }` must not be
// reported as changed when both sides carry the same patch, while an added or
// removed child does count as a change of the parent key.
//
// Pure module on purpose: no React / DOM imports, so it runs directly in node.

import { isPlainObject, type Modified } from "./config";

export type ModifiedDiff = {
  /** Keys present in `next` but not in `current`. */
  added: string[];
  /** Keys present in `current` but not in `next`. */
  removed: string[];
  /** Keys present in both whose values differ (compared structurally). */
  changed: string[];
};

/**
 * Structural equality for values found in `modified`: plain objects compare
 * order-insensitively, arrays compare element-wise (order matters), primitives
 * use `Object.is`.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }

  return false;
}

/**
 * Compare the current `modified` map with a parsed / candidate one.
 *
 * `order` is the schema's top-level option order: keys listed there are emitted
 * schema-first, everything else (e.g. an unknown option in hand-written YAML)
 * follows in a stable lexical order. A value of `undefined` is treated as an
 * absent key, matching the exporter's notion of "not modified".
 */
export function diffModified(
  current: Modified,
  next: Modified,
  order: readonly string[] = [],
): ModifiedDiff {
  const before = definedEntries(current);
  const after = definedEntries(next);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [key, value] of after) {
    if (!before.has(key)) added.push(key);
    else if (!deepEqual(before.get(key), value)) changed.push(key);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed.push(key);
  }

  return {
    added: sortKeys(added, order),
    removed: sortKeys(removed, order),
    changed: sortKeys(changed, order),
  };
}

function definedEntries(modified: Modified): Map<string, unknown> {
  const entries = new Map<string, unknown>();
  for (const [key, value] of Object.entries(modified)) {
    if (value !== undefined) entries.set(key, value);
  }
  return entries;
}

function sortKeys(keys: readonly string[], order: readonly string[]): string[] {
  const rank = new Map<string, number>();
  order.forEach((key, index) => {
    if (!rank.has(key)) rank.set(key, index);
  });

  return [...keys].sort((left, right) => {
    const leftRank = rank.get(left);
    const rightRank = rank.get(right);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
