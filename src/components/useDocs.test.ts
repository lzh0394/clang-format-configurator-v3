import { describe, expect, it } from "vitest";

import { prepareDocsHtml } from "./useDocs";

// Render-layer fix for the build-time docs HTML (M3 legacy: docs `<pre>` was not
// focusable, and RST block directives leaked into the "Meaning" table cells).
// The function must add accessibility/readability without decoding entities or
// touching markup attributes.

/** Sample from the generated docs.json (top-level code block). */
const PARAGRAPH_AND_CODE =
  '<p><code>Consecutive</code> will result in formattings like:</p>\n<pre><code>int a            = 1;\nint somelongname = 2;</code></pre>';

/** Sample from the generated enum table: the directive leaked into prose. */
const TABLE_CELL =
  '<table class="enum-values"><thead><tr><th>Value</th><th>Meaning</th></tr></thead><tbody><tr><td><code>Align</code></td><td>Align parameters on the open bracket, e.g.: .. code-block:: c++ someLongFunction(argument1, argument2);</td></tr></tbody></table>';

describe("prepareDocsHtml - focusable code blocks", () => {
  it("makes scrollable <pre> blocks tab stops", () => {
    const html = prepareDocsHtml(PARAGRAPH_AND_CODE);
    expect(html).toContain('<pre tabindex="0"><code>');
    expect(html).toContain("int somelongname = 2;");
  });

  it("keeps existing attributes and tabindex values", () => {
    expect(prepareDocsHtml('<pre class="x"><code>a</code></pre>')).toBe(
      '<pre tabindex="0" class="x"><code>a</code></pre>',
    );
    expect(prepareDocsHtml('<pre tabindex="-1">a</pre>')).toBe('<pre tabindex="-1">a</pre>');
    expect(prepareDocsHtml('<pre tabindex="0">a</pre>')).toBe('<pre tabindex="0">a</pre>');
  });

  it("is idempotent (no duplicate tabindex when applied twice)", () => {
    const once = prepareDocsHtml(PARAGRAPH_AND_CODE);
    expect(prepareDocsHtml(once)).toBe(once);
  });

  it("leaves non-pre markup untouched", () => {
    const html = '<p>Plain <code>paragraph</code>.</p>\n<ul><li>item</li></ul>';
    expect(prepareDocsHtml(html)).toBe(html);
    expect(prepareDocsHtml("")).toBe("");
  });
});

describe("prepareDocsHtml - leaked RST directives", () => {
  it("drops the code-block marker in a flattened table cell", () => {
    const html = prepareDocsHtml(TABLE_CELL);
    expect(html).not.toContain("code-block::");
    expect(html).not.toContain("c++ someLongFunction");
    expect(html).toContain("Align parameters on the open bracket, e.g.:");
    expect(html).toContain("someLongFunction(argument1, argument2);");
    // The line break keeps the snippet visually separate from the prose.
    expect(html).toContain("<br>someLongFunction");
  });

  it("labels admonition directives instead of showing the raw marker", () => {
    const html = prepareDocsHtml(
      "<td>Only applies with <code>Cpp11BracedListStyle</code>. .. note:: This currently only applies to braced lists.</td>",
    );
    expect(html).not.toContain(".. note::");
    expect(html).toContain("<strong>Note:</strong> This currently only applies to braced lists.");
    expect(html).toContain("<code>Cpp11BracedListStyle</code>");
  });

  it("does not leave a stray line break when the marker closes the text", () => {
    const html = prepareDocsHtml("<td>Some prose. .. code-block:: js</td>");
    expect(html).toBe("<td>Some prose. </td>");
  });

  it("does not eat a code-block marker at the start of a cell", () => {
    const html = prepareDocsHtml("<td>.. code-block:: yaml QualifierOrder: [inline]</td>");
    expect(html).not.toContain("<br>");
    expect(html).toContain("QualifierOrder: [inline]");
  });
});

describe("prepareDocsHtml - readable inline RST", () => {
  it("turns hyperlink literals into plain readable text", () => {
    const html = prepareDocsHtml(
      "`POSIX extended &lt;https://pubs.opengroup.org/a.html?x=1&amp;y=2&gt;`_ regular expressions are supported.",
    );
    expect(html).toBe(
      "POSIX extended (https://pubs.opengroup.org/a.html?x=1&amp;y=2) regular expressions are supported.",
    );
    expect(html).not.toContain("`_");
  });

  it("wraps single-backtick literals in <code>", () => {
    expect(prepareDocsHtml("in `SpacesInParensOptions`.")).toBe("in <code>SpacesInParensOptions</code>.");
  });

  it("leaves unbalanced backticks alone", () => {
    expect(prepareDocsHtml("a `lonely backtick")).toBe("a `lonely backtick");
  });
});

describe("prepareDocsHtml - escaping stays intact", () => {
  it("keeps HTML entities escaped", () => {
    const html = "<p>a &lt; b &amp;&amp; c &gt; d</p>";
    expect(prepareDocsHtml(html)).toBe(html);
  });

  it("does not turn escaped markup back into tags", () => {
    const html = "<p>Use &lt;pre&gt; for code.</p>";
    expect(prepareDocsHtml(html)).toBe(html);
  });

  it("never rewrites directive-looking text inside attributes", () => {
    const html = '<a href=".. code-block:: c++" title="&lt;pre&gt;">label</a>';
    expect(prepareDocsHtml(html)).toBe(html);
  });

  it("keeps escaped entities inside a cleaned table cell", () => {
    const html = prepareDocsHtml(
      "<td>e.g.: .. code-block:: c++ if (a &lt; b &amp;&amp; c &gt; d) {}</td>",
    );
    expect(html).toContain("if (a &lt; b &amp;&amp; c &gt; d) {}");
    expect(html).not.toContain("code-block::");
  });
});
