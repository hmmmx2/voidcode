/**
 * The research library: reading it, tracking what you have read, and opening a PDF.
 *
 * FETCHED ONLY WHEN SOMEBODY OPENS IT. Nothing here runs at startup, and the Privacy Policy says
 * so: the library is a network feature reached by an explicit action, like the VoidCode model and
 * the credit balance. A local-first application that quietly fetched a paper index on launch would
 * be contacting our server for someone who never asked it to.
 *
 * THE LIBRARY IS PUBLIC AND THE PROGRESS IS NOT, WHICH MAKES THE AUTH RULE UNUSUAL HERE.
 *
 * Every other call in this application either needs a session or does not. These two need one
 * *optionally*: the papers are public, and a session adds the reader's own ticks on top. So a
 * stored session is sent when there is one — and a 401 is not the end of the road. `platform/http.ts`
 * has by then already cleared the dead session (that is what a 401 means everywhere), and the
 * request is retried WITHOUT it, so a session that expired overnight leaves you reading the library
 * signed out rather than staring at an error about a paper that was never private.
 *
 * Exactly one retry, and only for that reason. A loop, or a retry on anything but a 401, would turn
 * a server having a bad minute into two servers having a bad minute.
 *
 * MARKING A SECTION READ IS THE OPPOSITE: it writes per-person state, so with no session it is
 * refused HERE, with no request made. The server would refuse it too (`require_user`), and the
 * reason the client refuses first is that a 401 from that call would end a session that is
 * perfectly valid — there is none to end, but the rule is worth holding without exception.
 */
import { shell } from "electron";
import { checkedExternalUrl } from "../net/external.js";
import { ApiNotConfiguredError, apiCall, type ApiResult } from "../platform/http.js";
import { sessionToken } from "../account/session.js";
import type { PaperDetail, PaperLibrary, SectionKey } from "../../shared/research.js";

export type Failure = {
  ok: false;
  /** `offline`, `not_configured`, `not_found`, `signed_out`, `no_pdf`, or `http_<status>`. */
  code: string;
  message: string;
};

const OFFLINE: Failure = {
  ok: false,
  code: "offline",
  message: "The research library needs a connection. Check yours and try again.",
};

/**
 * The last detail fetched per slug, for `openPdf` alone.
 *
 * NOT A READ CACHE. `get()` always asks the server, because the reader's own progress is part of
 * the answer and a stale tick is a lie about what they have done. What this holds is the PDF
 * address, so pressing "Open PDF" on a paper you are already reading does not need a second round
 * trip before the browser opens. Unbounded only in the sense that the library is a shelf; a URL per
 * paper is a few hundred bytes and the process is not long-lived enough for that to matter.
 */
const pdfUrls = new Map<string, string>();

/** Both reads share this: send the session if there is one, and fall back to anonymous on a 401. */
async function readWithOptionalSession(path: string): Promise<ApiResult | Failure> {
  try {
    if (sessionToken() !== undefined) {
      const authenticated = await apiCall(path, { auth: true });
      // Anything but a 401 is the answer, including a 404 and a 500.
      if (authenticated.status !== 401) return authenticated;
      // The session is gone and `http.ts` has already said so. The library is still public.
    }
    return await apiCall(path, {});
  } catch (err) {
    return err instanceof ApiNotConfiguredError
      ? { ok: false, code: "not_configured", message: err.message }
      : OFFLINE;
  }
}

function isFailure(value: ApiResult | Failure): value is Failure {
  return (value as Failure).ok === false;
}

export async function list(): Promise<{ ok: true; library: PaperLibrary } | Failure> {
  const result = await readWithOptionalSession("/papers");
  if (isFailure(result)) return result;
  if (result.status !== 200) {
    return { ok: false, code: `http_${String(result.status)}`, message: "Could not read the library." };
  }
  const body = result.body as PaperLibrary | null;
  if (body === null || !Array.isArray(body.papers)) {
    return { ok: false, code: "bad_response", message: "The library came back in a shape VoidCode did not expect." };
  }
  return { ok: true, library: body };
}

export async function get(slug: string): Promise<{ ok: true; paper: PaperDetail } | Failure> {
  const result = await readWithOptionalSession(`/papers/${encodeURIComponent(slug)}`);
  if (isFailure(result)) return result;
  if (result.status === 404) {
    return { ok: false, code: "not_found", message: "There is no paper with that name." };
  }
  if (result.status !== 200) {
    return { ok: false, code: `http_${String(result.status)}`, message: "Could not read that paper." };
  }
  const paper = result.body as PaperDetail | null;
  if (paper === null || typeof paper.slug !== "string" || !Array.isArray(paper.sections)) {
    return { ok: false, code: "bad_response", message: "That paper came back in a shape VoidCode did not expect." };
  }
  if (typeof paper.pdfUrl === "string") pdfUrls.set(paper.slug, paper.pdfUrl);
  return { ok: true, paper };
}

export async function markRead(
  slug: string,
  section: SectionKey,
): Promise<{ ok: true; sectionsRead: string[]; completedAt: string | null } | Failure> {
  // Refused before the network, not after: see the module header.
  if (sessionToken() === undefined) {
    return { ok: false, code: "signed_out", message: "Sign in to keep track of what you have read." };
  }
  let result;
  try {
    result = await apiCall(`/papers/${encodeURIComponent(slug)}/read`, {
      method: "POST",
      auth: true,
      body: JSON.stringify({ section }),
    });
  } catch {
    return OFFLINE;
  }
  if (result.status === 401) {
    return { ok: false, code: "signed_out", message: "Your VoidCode session ended." };
  }
  if (result.status !== 200) {
    return { ok: false, code: `http_${String(result.status)}`, message: "Could not record that." };
  }
  const body = result.body as { sectionsRead?: unknown; completedAt?: unknown } | null;
  return {
    ok: true,
    sectionsRead: Array.isArray(body?.sectionsRead)
      ? body.sectionsRead.filter((s): s is string => typeof s === "string")
      : [],
    completedAt: typeof body?.completedAt === "string" ? body.completedAt : null,
  };
}

/**
 * Open a paper's PDF in the reader's own browser.
 *
 * THE RENDERER NAMES A SLUG AND NEVER A URL. The address comes from our own API over TLS — from
 * the cache if this paper has been fetched, otherwise by fetching it now — and is then checked
 * before anything is opened. `shell.openExternal` will launch whatever the operating system has a
 * handler for, so the set of things a renderer can cause to be opened has to be a set of papers
 * rather than a set of strings.
 *
 * `allowLoopbackHttp: false`, unlike the checkout URL: a paper lives on arXiv, and there is no
 * development case for a plain-http one. `checkedExternalUrl` also refuses embedded credentials.
 */
export async function openPdf(slug: string): Promise<{ ok: true } | Failure> {
  let url = pdfUrls.get(slug);
  if (url === undefined) {
    const fetched = await get(slug);
    if (!fetched.ok) return fetched;
    url = fetched.paper.pdfUrl;
  }
  if (typeof url !== "string" || url === "") {
    return { ok: false, code: "no_pdf", message: "That paper has no PDF to open." };
  }

  const parsed = checkedExternalUrl(url, { allowLoopbackHttp: false });
  if (parsed === null) {
    // Not a generic failure message: this one means our own content is wrong, and saying so is how
    // it gets noticed rather than read as a network problem.
    return {
      ok: false,
      code: "unsafe_pdf",
      message: "Refused to open that PDF: it is not a secure HTTPS address.",
    };
  }
  await shell.openExternal(parsed.toString());
  return { ok: true };
}

/** Tests only: forget the cached PDF addresses. */
export function __resetPdfCache(): void {
  pdfUrls.clear();
}
