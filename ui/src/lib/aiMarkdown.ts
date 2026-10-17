// Renders the assistant's Markdown answers as HTML that is safe to insert: raw HTML
// and images are shown as text, and links are either Dotion pages
// ([Title](dotion:<id>)) or plain http(s) links opened outside the app.
import { Marked, type Tokens } from "marked";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
  renderer: {
    html: ({ text }: Tokens.HTML | Tokens.Tag) => esc(text),
    image: ({ text }: Tokens.Image) => esc(text),
    link(this: { parser: { parseInline(t: Tokens.Link["tokens"]): string } }, { href, tokens }: Tokens.Link) {
      const label = this.parser.parseInline(tokens);
      if (href.startsWith("dotion:")) {
        const id = href.slice("dotion:".length);
        return UUID.test(id) ? `<a href="#" data-entry="${id}" class="ai-page-link">${label}</a>` : label;
      }
      if (/^https?:\/\//i.test(href)) return `<a href="${esc(href)}" data-external="1" rel="noreferrer">${label}</a>`;
      return label;
    },
  },
});

export function renderAiMarkdown(text: string): string {
  return md.parse(text) as string;
}
