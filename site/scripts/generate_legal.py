#!/usr/bin/env python3
"""Generate the site's Terms and Privacy pages from the ones the application ships.

WHY A GENERATOR RATHER THAN TWO COPIES OF THE PROSE

Stripe needs a public privacy URL, Google will need one, and a person deciding whether to install
the app wants to read the terms before downloading — so these documents have to exist as web pages
as well as inside the app. Keeping two hand-written copies of ten pages of legal prose has one
predictable outcome: they diverge, and the divergence is discovered by someone who relied on the
wrong one. The application's `PrivacyClient.tsx` and `TermsClient.tsx` are the originals; this
script renders them to HTML, and `tests/test_site.py` regenerates in memory and fails if the
committed pages differ. The pages are committed rather than built on deploy because the site has no
build step at all — it is served as files.

Run it after editing either document:

    python site/scripts/generate_legal.py

WHAT IT DOES NOT DO

It is not a JSX parser. It handles exactly the constructs those two files use — fragments, the
`className` attributes, `<Link>`, `{" "}`, JSX comments, and the one warning box with an inline
icon — and it *fails loudly* rather than guessing: anything left that looks like JSX after the
conversion raises. That is the property that matters. A silent partial conversion would publish a
legal document with a hole in it.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LEGAL = ROOT / "desktop/renderer/src/components/Legal"
SHARED_LEGAL = ROOT / "desktop/src/shared/legal.ts"
SITE = ROOT / "site"


@dataclass(frozen=True)
class Document:
    """One legal document: where it comes from, and how the page it becomes is framed."""

    source: str
    out: str
    title: str
    subtitle: str
    #: The other document, linked from the header nav as the current page's sibling.
    other: str


DOCUMENTS = (
    Document(
        source="PrivacyClient.tsx",
        out="privacy/index.html",
        title="Privacy Policy",
        subtitle="What the application stores on your machine, what leaves it, and what an optional account keeps.",
        other="terms",
    ),
    Document(
        source="TermsClient.tsx",
        out="terms/index.html",
        title="Terms of Use",
        subtitle="How this application is licensed, what it does not promise, and what an optional account involves.",
        other="privacy",
    ),
)


def display_date() -> str:
    """The date both documents print, from the constant registration records."""
    text = SHARED_LEGAL.read_text(encoding="utf-8")
    match = re.search(r'TERMS_DISPLAY_DATE = "([^"]+)"', text)
    if match is None:
        raise SystemExit("TERMS_DISPLAY_DATE is not in src/shared/legal.ts")
    return match.group(1)


def sections(source: str) -> list[tuple[str, str, str]]:
    """Every `{id, title, content}` in the component's SECTIONS array, in order.

    Split on the `id:` lines rather than trying to balance JSX brackets: the array is one flat list
    of objects whose shape is fixed by the `Section` interface, and each entry runs to the start of
    the next one.
    """
    body = source.split("const SECTIONS: Section[] = [", 1)
    if len(body) != 2:
        raise SystemExit("no SECTIONS array found")
    body = body[1].split("\n// ── Sub-components", 1)[0]

    starts = [m.start() for m in re.finditer(r'^    id: "', body, re.MULTILINE)]
    if not starts:
        raise SystemExit("no sections found")
    starts.append(len(body))

    out: list[tuple[str, str, str]] = []
    for index in range(len(starts) - 1):
        chunk = body[starts[index] : starts[index + 1]]
        section_id = re.search(r'id: "([^"]+)"', chunk)
        title = re.search(r'title: "([^"]+)"', chunk)
        content = chunk.split("content: (", 1)
        if section_id is None or title is None or len(content) != 2:
            raise SystemExit(f"section {index} is not shaped as expected")
        out.append((section_id.group(1), title.group(1), content[1]))
    return out


def to_html(jsx: str, other: str) -> str:
    """The JSX body of one section as HTML.

    Every substitution here exists because those two files use the construct; each is asserted to
    have left nothing JSX-shaped behind at the end of the function.
    """
    html = jsx

    # Cut at the `),` that closes this section's `content:` — a chunk runs to the start of the next
    # section, so its tail carries the previous object's closing braces and the next one's opening.
    html = re.split(r"\n\s*\),\s*\n\s*\},", html, maxsplit=1)[0]
    html = html.replace("<>", "").replace("</>", "")

    # JSX comments: `{/* … */}`.
    html = re.sub(r"\{/\*.*?\*/\}", "", html, flags=re.DOTALL)

    # The one inline icon, in the "treat what you type as leaving your machine" box. An <svg> of a
    # warning triangle carries no information the sentence beside it does not.
    html = re.sub(r"<svg\b.*?</svg>", "", html, flags=re.DOTALL)

    # `<Link href="/terms" …>` and `<Link href="/privacy" …>` — in the app they are routes; here
    # they are sibling directories, and the link must work from inside /privacy/ or /terms/.
    def link(match: re.Match[str]) -> str:
        target = match.group(1).strip("/")
        return f'<a href="../{target}/">'

    html = re.sub(r'<Link\s+href="(/[a-z]+)"[^>]*>', link, html, flags=re.DOTALL)
    html = html.replace("</Link>", "</a>")

    # An `<a>` that names a real URL keeps its href (and `target`/`rel` when it is external);
    # everything else in the tag is styling.
    def anchor(match: re.Match[str]) -> str:
        tag = match.group(0)
        href = re.search(r'href="([^"]+)"', tag)
        if href is None:
            raise SystemExit(f"an <a> with no href: {tag[:80]}")
        external = ' target="_blank" rel="noopener noreferrer"' if "target=" in tag else ""
        return f'<a href="{href.group(1)}"{external}>'

    html = re.sub(r"<a\s[^>]*>", anchor, html, flags=re.DOTALL)

    # Everything else is a plain element wearing Tailwind classes.
    html = re.sub(r'\s+className=(?:"[^"]*"|\{`[^`]*`\})', "", html)
    html = re.sub(r"\s+(?:id|aria-hidden|style)=(?:\"[^\"]*\"|\{[^}]*\})", "", html)

    # The warning box: a bordered card in the app, a `.note` here.
    html = re.sub(r"<div>\s*(<p>\s*If you have selected)", r'<div class="note">\1', html)

    # `{" "}` is JSX's way of keeping a space that prettier would otherwise eat.
    html = html.replace('{" "}', " ")

    # Pull an inline element's text onto one line, and the punctuation that follows it onto the
    # same line as its closing tag. JSX wraps prose at the print margin and HTML turns each of
    # those line breaks into a space, so the source's formatting rendered as "Terms of Use ." with
    # the full stop adrift and the underline running past the last word.
    html = re.sub(
        r"<(a|strong|em|code)([^>]*)>\s*\n\s*(.+?)\s*\n\s*</\1>",
        lambda m: f"<{m.group(1)}{m.group(2)}>{' '.join(m.group(3).split())}</{m.group(1)}>",
        html,
        flags=re.DOTALL,
    )
    html = re.sub(r"(</(?:a|strong|em|code)>)\s*\n\s*([.,;:)])", r"\1\2", html)

    # Tidy: collapse the blank lines the removals leave, and drop the source's indentation.
    html = "\n".join(line.rstrip() for line in html.split("\n"))
    html = re.sub(r"\n{3,}", "\n\n", html).strip("\n")
    html = re.sub(r"^ {8}", "", html, flags=re.MULTILINE)

    leftovers = [c for c in ("className", "{", "}", "<Link", "</Link>", "<>") if c in html]
    if leftovers:
        raise SystemExit(f"conversion left JSX behind ({', '.join(leftovers)}):\n{html[:400]}")
    return html


def page(document: Document, updated: str, rendered: list[tuple[str, str, str]]) -> str:
    """One complete HTML page. The chrome matches index.html so the site reads as one thing."""
    body = "\n\n".join(
        f'        <section id="{section_id}">\n'
        f"          <h2>{title}</h2>\n"
        + "\n".join(f"          {line}" if line else "" for line in content.split("\n"))
        + "\n        </section>"
        for section_id, title, content in rendered
    )

    return f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{document.title} — VoidCode</title>
    <meta name="description" content="{document.subtitle}" />
    <!-- No scripts and nothing external on this page; see index.html for why the policy travels
         in the file rather than only in a header. -->
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'"
    />
    <link rel="icon" href="../favicon.svg" type="image/svg+xml" />
    <link rel="stylesheet" href="../assets/site.css" />
  </head>
  <body>
    <!-- GENERATED FILE — do not edit.
         Source: desktop/renderer/src/components/Legal/{document.source}
         Regenerate: python site/scripts/generate_legal.py
         tests/test_site.py fails if this file and that component disagree. -->
    <header class="bar">
      <div class="wrap">
        <a class="brand" href="../">
          <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="butt" aria-hidden="true">
            <path d="M20.384 7.012A10 10 0 1 1 11.616 7.012" />
          </svg>
          VoidCode
        </a>
        <nav class="links">
          <a href="../#download">Download</a>
          <a href="../terms/"{' aria-current="page"' if document.other == "privacy" else ""}>Terms</a>
          <a href="../privacy/"{' aria-current="page"' if document.other == "terms" else ""}>Privacy</a>
        </nav>
      </div>
    </header>

    <main class="wrap doc">
      <div class="doc-head">
        <div>
          <h1>{document.title}</h1>
          <p class="muted small" style="margin: 0">{document.subtitle}</p>
        </div>
        <p class="updated" style="margin: 0">Last updated <strong>{updated}</strong></p>
      </div>

{body}
    </main>

    <footer>
      <div class="wrap">
        <span>VoidCode AI</span>
        <nav>
          <a href="../terms/">Terms of Use</a>
          <a href="../privacy/">Privacy Policy</a>
          <a href="../#download">Download</a>
        </nav>
      </div>
    </footer>
  </body>
</html>
"""


def render(document: Document) -> str:
    source = (LEGAL / document.source).read_text(encoding="utf-8")
    rendered = [
        (section_id, title, to_html(content, document.other))
        for section_id, title, content in sections(source)
    ]
    return page(document, display_date(), rendered)


def main(argv: list[str]) -> int:
    check = "--check" in argv
    stale: list[str] = []
    for document in DOCUMENTS:
        html = render(document)
        target = SITE / document.out
        current = target.read_text(encoding="utf-8") if target.exists() else None
        if current == html:
            continue
        if check:
            stale.append(document.out)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(html, encoding="utf-8", newline="\n")
        print(f"wrote {document.out}")
    if stale:
        print("stale (run without --check to regenerate): " + ", ".join(stale))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
