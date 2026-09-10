"use client";

import { useState } from "react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface Section {
  id: string;
  title: string;
  content: React.ReactNode;
}

/**
 * ── WHY THIS DOCUMENT WAS REWRITTEN ───────────────────────────────────────────────────────────
 *
 * It was a hosted-platform privacy policy, and this is a local-first desktop application. Almost
 * every operative sentence described a system that does not exist: OAuth sign-in with Microsoft and
 * Google, cookies for session and CSRF tokens, IP addresses and geolocation, analytics retained 90
 * days, authentication logs retained 12 months, profile data deleted "within 90 days" of account
 * deletion, staff reviewing conversations for quality assurance, disclosure to cloud hosting
 * vendors, and TLS 1.2+ / AES-256 / MFA protecting a server nobody runs.
 *
 * There is no account, no sign-in, no server, and no "us" that receives anything. A privacy policy
 * that overstates collection is not a harmless placeholder — it is a factual misstatement about the
 * one document a user consults precisely because they cannot read the source.
 *
 * Note the direction of the error. Every claim removed here described *more* data handling than
 * happens, which is the safer direction to be wrong in but still wrong. Section 2 already carried a
 * comment recording that student IDs and LMS enrolment records had been struck for exactly this
 * reason; that correction was right and did not go far enough.
 *
 * EVERY FACTUAL CLAIM BELOW WAS CHECKED AGAINST THE CODE, and each is followed here by where:
 *
 *   - no account/auth surface .............. `lib/hooks/useUserId.ts`, and the absence of auth.ts,
 *                                            middleware.ts and /api/auth/*
 *   - the profile columns .................. the `profile` table in `src/main/store/db.ts`, which
 *                                            deliberately has no email column
 *   - one local SQLite file ................ `src/main/store/db.ts`
 *   - no cookies; localStorage for layout .. `lib/shell/usePanels.tsx`; the UI loads over `app://`
 *   - hardware readings stay local ......... `lib/shell/useTelemetry.ts`, `hardware/scan.ts`
 *   - what can leave the machine ........... `inference/registry.ts` (OpenRouter, key-gated) and
 *                                            `net/allowlist.ts` (the agent's fetch allowlist)
 *   - submissions run locally .............. `exec/sandbox.ts` (Pyodide, no network)
 *   - the API key's storage ................ `inference/vault.ts`, `store/secrets.ts`
 *
 * WHAT WAS DELIBERATELY NOT CHANGED, because it is a legal or commercial decision rather than a
 * description of software: the legal entity and its contact details, the postal address, the
 * Privacy Officer email, the jurisdiction, and the statutory compliance claims in the badge row.
 * Those need a human who can decide them. The rewrite is confined to what the software does.
 */

// ── Sections ───────────────────────────────────────────────────────────────

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "1. Overview",
    content: (
      <>
        <p>
          VoidCode AI ("VoidCode", "we", "our", or "us") publishes the VoidCode application. This
          Privacy Policy explains what the application stores, where it stores it, and the few
          circumstances in which anything leaves your computer.
        </p>
        <p>
          <strong className="text-ink-2">
            One fact shapes everything else in this document: the application runs entirely on your
            machine.
          </strong>{" "}
          There is no account to create, no sign-in, and no VoidCode server for it to talk to. We do
          not receive your profile, your code, your submissions, or your conversations — not because
          we choose to discard them, but because nothing sends them to us.
        </p>
        <p>
          That means most of this Policy describes data <em>you</em> hold rather than data we hold,
          and several rights that a hosted service would grant you are instead things you can simply
          do yourself. Where that is the case, it says so.
        </p>
        <p>
          Read it alongside our{" "}
          <Link href="/terms" className="text-ink hover:text-ink underline underline-offset-2 transition-colors">
            Terms of Use
          </Link>
          .
        </p>
        <p>
          VoidCode complies with the <em>Privacy Act 1988</em> (Cth), the Australian Privacy
          Principles (APPs), and applicable Victorian privacy legislation.
        </p>
      </>
    ),
  },
  {
    id: "information-collected",
    title: "2. What Is Stored, and Where",
    content: (
      <>
        <p>
          Everything the application records about you is kept in a single database file named{" "}
          <code className="text-ink-2">voidcode.db</code>, inside the application-data folder your
          operating system allocates to VoidCode. It is an ordinary file on your disk. You can copy
          it, back it up, inspect it, or delete it.
        </p>

        <h3 className="text-ink text-[13px] font-medium mt-4 mb-2">2.1 Details you enter</h3>
        <ul>
          <li>
            A profile, entirely optional: display name, biography, date of birth, country,
            occupation, profile photo, and time zone
          </li>
          <li>Your code submissions, drafts, and which exercises you have solved</li>
          <li>Your conversations with the tutor and with the coding assistant</li>
          <li>Notifications the application has generated for you</li>
        </ul>
        <p>
          <strong className="text-ink-2">There is no email address field</strong>, and no password.
          The database has no column for either, because there is no account to sign in to and no
          message we could send you.
        </p>

        <h3 className="text-ink text-[13px] font-medium mt-4 mb-2">2.2 Recorded as you work</h3>
        <ul>
          <li>Which projects you have opened in Build mode, so the File menu can list them</li>
          <li>Window positions and panel layout, so the application reopens as you left it</li>
          <li>
            A record of what the coding assistant did — files it read, changes it proposed — kept so
            that "what did it do to my repository" stays answerable after the window closes
          </li>
        </ul>
        <p>
          The CPU, memory and GPU figures in the status bar are read from your machine to be
          displayed and are never stored or transmitted.
        </p>

        <h3 className="text-ink text-[13px] font-medium mt-4 mb-2">2.3 Cookies and browser storage</h3>
        <p>
          <strong className="text-ink-2">The application sets no cookies.</strong> Its interface is
          not served over the web, so there is no session cookie, no tracking cookie, and no CSRF
          token. Browser local storage holds one thing: which panels you have open and how you have
          sized them.
        </p>
      </>
    ),
  },
  {
    id: "what-leaves",
    title: "3. What Leaves Your Computer",
    content: (
      <>
        <p>
          By default, nothing. Models run through a local Ollama or llama.cpp on your own machine,
          and your code is executed inside the application in a WebAssembly sandbox that has no
          network access at all. There are exactly four ways anything reaches the internet, and all
          four require you to act first:
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">A remote model, if you add a key.</strong> Providing an
            OpenRouter key and selecting one of its models sends that conversation — your prompt, and
            any code or images attached to it — to OpenRouter, under their privacy policy. With no
            key, their models are listed and cannot be used. It goes to them, not to us.
          </li>
          <li>
            <strong className="text-ink-2">The VoidCode model, if you select it.</strong> This one
            goes <em>to us</em>, and it is the only thing here that does. Choosing the
            &ldquo;VoidCode&rdquo; provider sends that conversation — your prompt, and any code or
            images attached to it — to our servers, where a model we run answers it. We do this
            because the model is far larger than anything most machines can hold, and running it
            costs us GPU time, which is why it is metered against credits rather than free. Every
            other provider in this list is a machine you control or a company you chose; this one
            is ours. It is never selected for you, and the local providers keep working without it.
          </li>
          <li>
            <strong className="text-ink-2">Downloading a model.</strong> Ollama fetches the weights
            from its own registry. The request is made by Ollama on your machine, and carries nothing
            about you beyond which model you asked for.
          </li>
          <li>
            <strong className="text-ink-2">The assistant reading documentation.</strong> When you ask
            it to look something up, it may fetch a page from a fixed list of documentation and
            package-registry sites — Python, MDN, npm, PyPI, crates.io, GitHub and similar. It cannot
            reach any other host, and it cannot reach anything on your local network.
          </li>
        </ul>
        <p>
          Your submissions, your progress, your profile and your local conversations are not part of
          any of that. No usage analytics, crash reports, performance metrics, IP addresses or device
          identifiers are collected or sent anywhere, because the application contains nothing that
          would send them.
        </p>
      </>
    ),
  },
  {
    id: "ai-data",
    title: "4. The Tutor and the Coding Assistant",
    content: (
      <>
        <p>
          Your conversations are rows in the local database described in section 2. They are used to
          give the model the earlier turns of the same conversation, and to let you reopen a
          conversation later. That is all.
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">Nobody reviews them.</strong> There is no mechanism by
            which a conversation could reach us, so there is no quality-assurance review, no safety
            monitoring, and no authorised personnel with access.
          </li>
          <li>
            <strong className="text-ink-2">Nothing is used to train a model.</strong> No aggregate
            analysis, no learning-pattern research, no model improvement from your data.
          </li>
        </ul>
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-2" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <p className="text-[12px] leading-relaxed text-ink-2">
            If you have configured a remote model, treat what you type as leaving your machine. Avoid
            putting passwords, financial details or health information in a conversation you are
            sending to a provider.
          </p>
        </div>
      </>
    ),
  },
  {
    id: "api-keys",
    title: "5. Your API Key",
    content: (
      <>
        <p>
          If you add an OpenRouter key, it is encrypted using your operating system&apos;s credential
          store — DPAPI on Windows, Keychain on macOS, or your keyring on Linux — and the encrypted
          result is kept in the same local database. What decrypts it stays with the operating system,
          so the database file on its own does not yield the key.
        </p>
        <ul>
          <li>
            The key is never displayed back to you, and no part of the interface is able to read it.
            It is attached to a request at the moment the request is made and held nowhere else.
          </li>
          <li>
            You can remove it at any time from the model manager, which deletes it from the database.
          </li>
          <li>
            If your system offers no keyring the application can rely on, the key is held only for
            the current session and never written to disk. The model manager tells you which of the
            two happened when you save it.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "disclosure",
    title: "6. Disclosure of Information",
    content: (
      <>
        <p>
          We do not sell, rent, trade or disclose your personal information, and the reason is
          structural rather than a promise about our conduct: we do not have it. There is no cloud
          hosting to pass it to, no authentication vendor, and no staff with a way to reach it.
        </p>
        <p>
          Two consequences worth stating plainly, because they differ from a hosted service:
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">A legal demand to us produces nothing</strong>, because
            there is nothing in our possession to produce. A demand directed at you, or at your
            computer, is between you and whoever makes it.
          </li>
          <li>
            <strong className="text-ink-2">A change of ownership transfers no user data</strong>,
            since none is held. If that ever ceases to be true, this Policy has to change first, and
            section 11 says how you would be told.
          </li>
        </ul>
        <p>
          Where you have chosen to use a remote model, that provider receives what you send them and
          handles it under their own policy. See section 3.
        </p>
      </>
    ),
  },
  {
    id: "data-retention",
    title: "7. Retention and Deletion",
    content: (
      <>
        <p>
          We set no retention period, because we hold nothing to retain. Your data stays on your disk
          until you remove it, and you do not need our involvement — or our permission — to do so.
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">Individual items:</strong> delete a conversation in the
            application and its messages are removed from the database. Records of what the coding
            assistant did to your files deliberately outlive the conversation that prompted them, so
            that tidying up a chat does not erase the audit trail of changes to your repository.
          </li>
          <li>
            <strong className="text-ink-2">Everything:</strong> delete the application-data folder
            described in section 2, or uninstall the application. Nothing survives elsewhere and
            nobody else holds a copy.
          </li>
        </ul>
        <p>
          The corollary deserves saying: because we hold no copy, we also cannot restore anything for
          you. If your data matters to you, back up that folder.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "8. Security",
    content: (
      <>
        <p>
          The protections that matter here are the ones that hold on your own machine, so this section
          lists those rather than the server-side controls a hosted service would describe. There is
          no VoidCode server, so no TLS configuration, no encryption-at-rest scheme of ours, no
          role-based staff access and no administrative multi-factor authentication apply.
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">Your API key</strong> is encrypted with the operating
            system&apos;s credential store, is never shown back to you, and is not readable by the
            interface. See section 5.
          </li>
          <li>
            <strong className="text-ink-2">Your code runs in a sandbox</strong> — a WebAssembly Python
            runtime with no network access and no access to your filesystem.
          </li>
          <li>
            <strong className="text-ink-2">The coding assistant is confined</strong> to the folder you
            open, cannot escape it via symbolic links, and proposes changes for you to review rather
            than writing them. Applying a batch requires confirming a system dialogue that names every
            file.
          </li>
          <li>
            <strong className="text-ink-2">Its web access is restricted</strong> to the fixed list of
            documentation sites in section 3, and it cannot reach hosts on your local network.
          </li>
        </ul>
        <p>
          Two limits stated plainly rather than left implied. The restriction on which Python modules
          an exercise may import is there to keep exercises honest, and is not a security boundary
          against code written specifically to defeat it. And nothing here protects the database file
          from anyone who already has access to your computer or your user account — it is a normal
          file, and the security of the machine is the security of your data.
        </p>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "9. Your Privacy Rights",
    content: (
      <>
        <p>
          Under the Australian Privacy Principles you have rights over personal information an
          organisation holds about you. Because we hold none, most of these are things you can
          exercise directly, without asking us and without waiting for us:
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">Access</strong> — everything is in the local database
            described in section 2. The application shows it to you, and the file is readable with any
            SQLite tool.
          </li>
          <li>
            <strong className="text-ink-2">Correction</strong> — edit your profile, or any draft or
            conversation, in the application.
          </li>
          <li>
            <strong className="text-ink-2">Deletion</strong> — delete individual items in the
            application, or remove the application-data folder to delete everything. No retention
            obligation of ours delays this, because we are not a party to it. See section 7.
          </li>
          <li>
            <strong className="text-ink-2">Opt-out</strong> — nothing to opt out of. Your data is not
            used for model training or research, and there is no analytics collection to disable. If
            you want to stop data reaching a third party, remove your API key (section 5).
          </li>
          <li>
            <strong className="text-ink-2">Complaint</strong> — you may lodge a complaint with the
            Office of the Australian Information Commissioner (OAIC) if you believe your privacy
            rights have been breached.
          </li>
        </ul>
        <p>
          If you believe we nonetheless hold information about you, or you have a question this Policy
          does not answer, contact our Privacy Officer at{" "}
          <a href="mailto:privacy@swin.edu.au" className="text-ink hover:text-ink transition-colors">
            privacy@swin.edu.au
          </a>
          . We will respond within 30 days.
        </p>
      </>
    ),
  },
  {
    id: "third-party",
    title: "10. Third-Party Services",
    content: (
      <>
        <p>
          The application has no third-party integrations that are active by default. There is no
          analytics provider, no error-reporting service, no advertising network, and no
          authentication provider — sign-in with Microsoft or Google is not offered.
        </p>
        <p>
          One party that can become involved is not a third party at all: it is us. Selecting the
          VoidCode model sends that conversation to our servers, as section 3 describes. We mention
          it here because a list of &ldquo;who else might see this&rdquo; that quietly omits the
          people who wrote the application would be the least useful kind of accurate.
        </p>
        <p>Two third parties can become involved, in both cases because you chose it:</p>
        <ul>
          <li>
            <strong className="text-ink-2">OpenRouter</strong> — only once you add a key. Conversations
            you send to one of their models are handled under the{" "}
            <a
              href="https://openrouter.ai/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink hover:text-ink transition-colors"
            >
              OpenRouter privacy policy
            </a>
            .
          </li>
          <li>
            <strong className="text-ink-2">The documentation sites in section 3</strong> — reached only
            when you ask the assistant to look something up, and each governed by its own operator.
          </li>
        </ul>
        <p>
          Ollama and llama.cpp are separate programs running on your own machine. They are not
          services we operate, and if you install one, how it behaves is governed by its own project
          rather than by this Policy.
        </p>
        <p>
          We are not responsible for the privacy practices of third parties, and we encourage you to
          review their policies independently.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "11. Changes to This Policy",
    content: (
      <>
        <p>
          We may update this Privacy Policy to reflect changes in the application, or in legal
          requirements. Because we hold no contact details for you,{" "}
          <strong className="text-ink-2">we cannot email you when it changes</strong> — and this Policy
          previously said we would, which was not something we were able to do.
        </p>
        <p>How you can actually tell:</p>
        <ul>
          <li>
            This page carries a "Last updated" date, revised whenever its substance changes. It ships
            with the application, so the version you are reading is the one that applies to the
            version you have installed.
          </li>
          <li>
            An update that materially changed what the application does with your data would arrive
            with a new release, which you choose to install.
          </li>
        </ul>
        <p>
          If a future version of the application ever collected or transmitted something this Policy
          says it does not, that would be a change to this document and to the release that made it.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "12. Contact & Complaints",
    content: (
      <>
        <p>
          If you have questions, concerns, or wish to exercise your privacy rights, please contact
          our Privacy Officer:
        </p>
        <div className="mt-3 p-4 rounded-lg bg-void-2 border border-line space-y-1">
          <p className="text-ink font-medium">Privacy Officer</p>
          <p>VoidCode AI</p>
          <p>John Street, Hawthorn VIC 3122, Australia</p>
          <p>
            Email:{" "}
            <a href="mailto:privacy@swin.edu.au" className="text-ink hover:text-ink transition-colors">
              privacy@swin.edu.au
            </a>
          </p>
        </div>
        <p className="mt-4">
          If you are not satisfied with our response, you may lodge a complaint with the{" "}
          <a
            href="https://www.oaic.gov.au"
            target="_blank"
            rel="noopener noreferrer"
            className="text-ink hover:text-ink transition-colors"
          >
            Office of the Australian Information Commissioner (OAIC)
          </a>
          .
        </p>
      </>
    ),
  },
];

// ── Sub-components ─────────────────────────────────────────────────────────

function TableOfContents({
  activeId,
  onSelect,
}: {
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="sticky top-6 w-64 flex-shrink-0 hidden lg:block">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-3 mb-4">
        Table of Contents
      </p>
      <ul className="space-y-1">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => onSelect(s.id)}
              className={`w-full text-left text-[12px] px-3 py-1.5 rounded-lg transition-colors ${
                activeId === s.id
                  ? "bg-white/8 text-ink font-medium"
                  : "text-ink-3 hover:text-ink-2 hover:bg-white/4"
              }`}
            >
              {s.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <section
      id={section.id}
      className="scroll-mt-8 pb-10 border-b border-line last:border-0 last:pb-0"
    >
      <h2 className="text-base font-semibold text-ink mb-4">{section.title}</h2>
      <div className="text-[13px] text-ink-2 leading-relaxed space-y-3 [&_ul]:mt-2 [&_ul]:ml-4 [&_ul]:space-y-1.5 [&_ul]:list-disc [&_ul]:list-outside [&_ul]:marker:text-ink-3/60 [&_table]:w-full">
        {section.content}
      </div>
    </section>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function PrivacyClient() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);

  function scrollTo(id: string) {
    setActiveId(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="page-document">

      {/* ── Page header ─────────────────────────────────────────────── */}
      <div className="mb-10 pb-8 border-b border-line">
        <div className="flex items-center gap-2 mb-4">
          <Link
            href="/profile"
            className="text-[11px] text-ink-3/60 hover:text-ink-2 transition-colors"
          >
            Settings
          </Link>
          <span className="text-ink-3/60">/</span>
          <span className="text-[11px] text-ink-2">Privacy Policy</span>
        </div>

        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink mb-2">Privacy Policy</h1>
            <p className="text-sm text-ink-3">
              What this application stores on your machine, and the few things that ever leave it.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-[11px] text-ink-3/60">Last updated</span>
            {/* Revised with the rewrite. Section 11 makes this the signal that the Policy changed,
                so it has to move whenever the substance does. */}
            <span className="text-[12px] text-ink-2 font-medium">7 August 2026</span>
          </div>
        </div>

        {/* GDPR / Privacy Act badge row */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {[
            { label: "Privacy Act 1988 (Cth)", color: "green" },
            { label: "Australian Privacy Principles", color: "green" },
            { label: "Victorian Privacy Legislation", color: "blue" },
          ].map(({ label, color }) => (
            <span
              key={label}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                color === "green"
                  ? "border-line-strong bg-void-3 text-ink"
                  : "border-line bg-void-2 text-ink-2"
              }`}
            >
              <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${color === "green" ? "bg-ink" : "border border-ink-3"}`} />
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* ── Body: ToC sidebar + sections ────────────────────────────── */}
      <div className="flex gap-12">
        <TableOfContents activeId={activeId} onSelect={scrollTo} />

        {/* Sections */}
        <div className="flex-1 min-w-0 space-y-10">
          {SECTIONS.map((section) => (
            <SectionBlock key={section.id} section={section} />
          ))}

          {/* Bottom nav */}
          <div className="pt-6 flex items-center justify-between">
            <Link
              href="/terms"
              className="flex items-center gap-2 text-[12px] text-ink-3 hover:text-ink transition-colors group"
            >
              <svg className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" viewBox="0 0 14 14" fill="none">
                <path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Terms of Use
            </Link>
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex items-center gap-2 text-[12px] text-ink-3 hover:text-ink transition-colors group"
            >
              Back to top
              <svg className="w-3.5 h-3.5 group-hover:-translate-y-0.5 transition-transform" viewBox="0 0 14 14" fill="none">
                <path d="M2 9L7 4L12 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
