# The public site

Four things live here, and nothing else: the landing page that hands people the installer, the
Terms of Use, the Privacy Policy, and the two pages Stripe redirects a buyer's browser to after a
payment.

**It is plain files.** No build step, no framework, no package manager. `python -m http.server -d
site 8080` serves it exactly as a host will. That is deliberate: this is the page someone reaches
when they cannot run the app yet, so it should have the fewest possible ways to be broken.

```
site/
  index.html                  landing page — and the download list is on it
  terms/index.html            GENERATED — see below
  privacy/index.html          GENERATED — see below
  purchase/success/           Stripe's success_url
  purchase/cancelled/         Stripe's cancel_url
  404.html
  assets/site.css             the app's tokens, copied; checked by tests/test_site.py
  assets/download.js          reads the release list from GitHub
  assets/fonts/               Inter + JetBrains Mono latin subsets, with their licences
  scripts/generate_legal.py   regenerates the two legal pages from the app's own documents
  _headers                    Cloudflare Pages / Netlify
  vercel.json                 Vercel
  robots.txt
```

## Before it is deployed

Two things have to be set by hand, and both are recorded here because neither can be guessed:

1. **The releases repository.** `index.html` carries
   `<meta name="voidcode:repo" content="" />`. Put `owner/name` of the GitHub repository that
   publishes the desktop releases in it. Until then the page says the first release has not been
   published rather than drawing a download button that leads nowhere — which is also the correct
   state today, because this project has no git remote yet.
2. **`APP_BASE_URL` on the API** must be this site's origin (`https://…`), because that is what the
   API builds Stripe's `success_url` and `cancel_url` from. In production the API refuses to start
   if it is not `https://`. See `apps/api/.env.example`.

## The download list

`assets/download.js` asks `api.github.com` for the latest release and matches assets by name —
`VoidCode-<version>-mac-arm64.dmg`, `-mac-x64.dmg`, `-win-x64.exe`, `-win-arm64.exe` — which is the
`artifactName` pattern in `desktop/electron-builder.yml`. Change that pattern and this page stops
finding the files; `tests/test_site.py` ties the two together so the test fails instead.

There is deliberately **no committed list of versions and checksums**. It would be a second source
of truth for the one thing on the page that must not be wrong, updated by hand right after a
release. The release list is the record.

Checksums come from each asset's `digest` field, which GitHub populates for releases published since
it was added. Older releases show "not published for this file" rather than a blank column.

## The legal pages are generated

`terms/index.html` and `privacy/index.html` are rendered from the documents the application ships —
`desktop/renderer/src/components/Legal/{TermsClient,PrivacyClient}.tsx`. Edit those, then:

```
python site/scripts/generate_legal.py
```

`tests/test_site.py` regenerates them in memory and fails if the committed pages differ, so the
website cannot say something the app does not. The "Last updated" date comes from `TERMS_VERSION` in
`desktop/src/shared/legal.ts`, which is also the version registration records as accepted.

## Hosting

Any static host. The three that need no configuration beyond a directory:

- **Cloudflare Pages** — build command: none, output directory: `site`. Reads `_headers`.
- **Vercel** — framework preset Other, root directory `site`. Reads `vercel.json`.
- **GitHub Pages** — publish the `site/` directory. Note it serves neither `_headers` nor
  `vercel.json`, so the headers those add (frame-ancestors, nosniff) are absent; every page still
  carries its `Content-Security-Policy` in a meta tag.

## What must never be added here

- **A third-party script, stylesheet or font.** The Content-Security-Policy on every page forbids
  it, and a download page that phones out to a CDN is telling on its visitors on the way to
  promising them a local-first editor. `tests/test_site.py` enforces it.
- **Anything from `data/`.** The exercise catalogue contains expected answers; publishing it would
  hand away the answer key. The test checks for that too.
- **A script on the purchase pages.** They are reached with a payment session id in the URL.
