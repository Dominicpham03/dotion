import { describe, expect, it } from "vitest";
import { extractText } from "./text";
import { markdownToDoc } from "./markdown";

describe("markdownToDoc", () => {
  it("turns a Google Doc export into editor blocks and drops raw HTML", () => {
    const doc = markdownToDoc(
      "## Plan\n\nShip **v2** by [Friday](https://example.com).\n\n- [ ] draft\n- notes\n\n```go\nfmt.Println(1)\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n",
    );
    const types = (doc.content ?? []).map((n) => n.type);
    expect(types).toEqual(expect.arrayContaining(["heading", "paragraph", "bulletList", "codeBlock", "table"]));
    const text = extractText(doc);
    expect(text).toContain("Ship v2 by Friday");
    expect(text).toContain("fmt.Println(1)");
    expect(JSON.stringify(doc)).not.toContain("alert");
    expect(JSON.stringify(doc)).toContain('"type":"bold"');
  });
});
