// Tests for the theme helpers.
//
// The node test environment has no DOM, so `resolveTheme` / `isThemePreference`
// are pure and `applyTheme` is exercised against a duck-typed root object (the
// only HTMLElement surface it touches: setAttribute/removeAttribute/style).
// `systemPrefersDark` is asserted to degrade gracefully without matchMedia.

import { describe, expect, it } from "vitest";

import {
  THEME_PREFERENCES,
  applyTheme,
  isThemePreference,
  resolveTheme,
  systemPrefersDark,
  type ThemePreference,
} from "./theme";

type FakeRoot = {
  attributes: Map<string, string>;
  style: { colorScheme: string };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
};

function makeRoot(): FakeRoot {
  const attributes = new Map<string, string>();
  return {
    attributes,
    style: { colorScheme: "" },
    setAttribute(name: string, value: string): void {
      attributes.set(name, value);
    },
    removeAttribute(name: string): void {
      attributes.delete(name);
    },
    getAttribute(name: string): string | null {
      return attributes.get(name) ?? null;
    },
  };
}

const asElement = (root: FakeRoot): HTMLElement => root as unknown as HTMLElement;

describe("isThemePreference", () => {
  it("accepts exactly the three preferences", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const value of ["System", "DARK", "", "auto", null, undefined, 1, true, {}, ["dark"]]) {
      expect(isThemePreference(value)).toBe(false);
    }
  });
});

describe("resolveTheme", () => {
  it("follows the system for the system preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("always honours an explicit choice", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("sets data-theme and color-scheme for an explicit dark choice", () => {
    const root = makeRoot();
    applyTheme("dark", asElement(root));

    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("sets data-theme and color-scheme for an explicit light choice", () => {
    const root = makeRoot();
    applyTheme("light", asElement(root));

    expect(root.attributes.get("data-theme")).toBe("light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("removes the attribute and the inline override for system", () => {
    const root = makeRoot();
    applyTheme("dark", asElement(root));
    expect(root.attributes.size).toBe(1);

    applyTheme("system", asElement(root));
    expect(root.attributes.has("data-theme")).toBe(false);
    expect(root.style.colorScheme).toBe("");
  });

  it("is idempotent", () => {
    const root = makeRoot();
    applyTheme("dark", asElement(root));
    applyTheme("dark", asElement(root));

    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("switches directly between light and dark", () => {
    const root = makeRoot();
    applyTheme("light", asElement(root));
    applyTheme("dark", asElement(root));

    expect(root.attributes.get("data-theme")).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });

  it("no-ops without a root or a document (SSR / node)", () => {
    // No root is provided and this environment has no document.
    expect(() => applyTheme("dark")).not.toThrow();
    expect(() => applyTheme("system")).not.toThrow();

    const root = makeRoot();
    expect(() => applyTheme("dark", root as unknown as HTMLElement)).not.toThrow();
    expect(root.attributes.get("data-theme")).toBe("dark");
  });
});

describe("systemPrefersDark", () => {
  it("degrades to false without window.matchMedia and never throws", () => {
    expect(systemPrefersDark()).toBe(false);
  });
});

describe("THEME_PREFERENCES", () => {
  it("lists the preferences in UI order", () => {
    expect(THEME_PREFERENCES).toEqual(["system", "light", "dark"]);
    expect(new Set(THEME_PREFERENCES).size).toBe(3);
    for (const preference of THEME_PREFERENCES) {
      expect(isThemePreference(preference)).toBe(true);
      expect(resolveTheme(preference as ThemePreference, false)).toBe(
        preference === "system" ? "light" : preference,
      );
    }
  });
});
