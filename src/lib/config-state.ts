// App configuration state (plan §4/§5): `{version, style, modified}` driven by
// useReducer. The reducer is pure so the whole model is unit-testable without a
// DOM.

import { isPlainObject, setChildOption, setOption, type Modified } from "./config";
import type { OptionDef, SchemaCore, StyleName } from "./schema";

export type ConfigState = {
  version: string;
  style: StyleName;
  modified: Modified;
};

export type ConfigAction =
  | { type: "setVersion"; version: string; schema: SchemaCore }
  | { type: "setStyle"; style: StyleName }
  | { type: "setOption"; key: string; value: unknown }
  | { type: "setChild"; option: OptionDef; childKey: string; value: unknown }
  | { type: "applyImport"; style: StyleName | null; modified: Modified }
  | { type: "resetAll" };

export function initialConfigState(version: string, style: StyleName = "LLVM"): ConfigState {
  return { version, style, modified: {} };
}

/**
 * Drop explicit values that do not exist in the target schema (e.g. after a
 * version switch) so they can never reach clang-format as unknown options.
 * Map overrides keep only children known to the new version.
 */
export function reconcileModified(
  modified: Modified,
  schema: SchemaCore,
): { modified: Modified; dropped: string[] } {
  const options = new Map(schema.options.map((option) => [option.key, option]));
  const next: Modified = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(modified)) {
    const option = options.get(key);
    if (!option) {
      dropped.push(key);
      continue;
    }

    if (option.type.kind === "map") {
      if (!isPlainObject(value)) {
        dropped.push(key);
        continue;
      }
      const children = new Set(option.type.children.map((child) => child.key));
      const filtered: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (children.has(childKey)) filtered[childKey] = childValue;
        else dropped.push(`${key}.${childKey}`);
      }
      if (Object.keys(filtered).length > 0) next[key] = filtered;
      continue;
    }

    if (option.type.kind === "list" && option.type.item === "struct" && !Array.isArray(value)) {
      dropped.push(key);
      continue;
    }

    next[key] = value;
  }

  return { modified: next, dropped };
}

export function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
  switch (action.type) {
    case "setVersion": {
      const { modified } = reconcileModified(state.modified, action.schema);
      return { version: action.version, style: state.style, modified };
    }
    case "setStyle":
      return { ...state, style: action.style };
    case "setOption":
      return { ...state, modified: setOption(state.modified, action.key, action.value) };
    case "setChild":
      return {
        ...state,
        modified: setChildOption(state.modified, action.option, action.childKey, action.value),
      };
    case "applyImport":
      return {
        ...state,
        style: action.style ?? state.style,
        modified: { ...action.modified },
      };
    case "resetAll":
      return { ...state, modified: {} };
    default:
      return state;
  }
}
