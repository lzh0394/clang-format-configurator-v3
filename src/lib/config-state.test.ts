import { describe, expect, it } from "vitest";
import { initialConfigState, reconcileModified, configReducer } from "./config-state";
import type { OptionDef, SchemaCore, StyleName } from "./schema";

const styles: StyleName[] = ["LLVM", "Google", "Chromium", "Mozilla", "WebKit", "Microsoft", "GNU"];

function schemaOf(options: OptionDef[]): SchemaCore {
  return { version: "21.1.8", build: "test", tag: "test", styles, options };
}

const braceWrapping: OptionDef = {
  key: "BraceWrapping",
  type: {
    kind: "map",
    children: [{ key: "AfterClass", type: { kind: "scalar", scalar: "bool" } }],
  },
  deprecated: false,
  defaults: { LLVM: { AfterClass: false } },
};

const indentWidth: OptionDef = {
  key: "IndentWidth",
  type: { kind: "scalar", scalar: "uint" },
  deprecated: false,
  defaults: { LLVM: 2 },
};

const schema = schemaOf([indentWidth, braceWrapping]);

describe("reconcileModified", () => {
  it("drops options and map children the target schema does not know", () => {
    const { modified, dropped } = reconcileModified(
      {
        IndentWidth: 4,
        RemovedInThisVersion: 1,
        BraceWrapping: { AfterClass: true, AfterExternBlock: true },
      },
      schema,
    );
    expect(modified).toEqual({ IndentWidth: 4, BraceWrapping: { AfterClass: true } });
    expect(dropped.sort()).toEqual(["BraceWrapping.AfterExternBlock", "RemovedInThisVersion"]);
  });

  it("drops an empty map override", () => {
    expect(reconcileModified({ BraceWrapping: {} }, schema).modified).toEqual({});
  });
});

describe("configReducer", () => {
  const base = initialConfigState("21.1.8");

  it("switches version while reconciling the modified set", () => {
    const state = configReducer({ ...base, modified: { IndentWidth: 4, Gone: 1 } }, {
      type: "setVersion",
      version: "18.1.8",
      schema,
    });
    expect(state).toEqual({ version: "18.1.8", style: "LLVM", modified: { IndentWidth: 4 } });
  });

  it("switches style without dropping explicit values", () => {
    const state = configReducer({ ...base, modified: { IndentWidth: 4 } }, {
      type: "setStyle",
      style: "GNU",
    });
    expect(state.style).toBe("GNU");
    expect(state.modified).toEqual({ IndentWidth: 4 });
  });

  it("sets whole options and map children", () => {
    let state = configReducer(base, { type: "setOption", key: "IndentWidth", value: 4 });
    state = configReducer(state, {
      type: "setChild",
      option: braceWrapping,
      childKey: "AfterClass",
      value: true,
    });
    expect(state.modified).toEqual({ IndentWidth: 4, BraceWrapping: { AfterClass: true } });
  });

  it("applies imports atomically and keeps the current style when absent", () => {
    const state = configReducer({ ...base, style: "GNU" }, {
      type: "applyImport",
      style: null,
      modified: { IndentWidth: 8 },
    });
    expect(state).toEqual({ version: "21.1.8", style: "GNU", modified: { IndentWidth: 8 } });
  });

  it("resets all modifications", () => {
    const state = configReducer({ ...base, modified: { IndentWidth: 4 } }, { type: "resetAll" });
    expect(state.modified).toEqual({});
  });
});
