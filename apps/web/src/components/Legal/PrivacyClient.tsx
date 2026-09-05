"use client";

import { useState } from "react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface Section {
  id: string;
  title: string;
  content: React.ReactNode;
}

// ── Sections ───────────────────────────────────────────────────────────────

const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "1. Overview",
    content: (
      <>
        <p>
          VoidCode AI ("VoidCode", "we", "our", or "us") is committed to
          protecting the privacy of all individuals who use the VoidCode AI platform
          ("Platform"). This Privacy Policy explains how we collect, use, disclose, and safeguard
          your personal information.
        </p>
        <p>
          This Policy applies to all users of the Platform and is to be read in conjunction with
          our{" "}
          <Link href="/terms" className="text-ink hover:text-ink underline underline-offset-2 transition-colors">
            Terms of Use
          </Link>
          . By using the Platform, you consent to the practices described in this Policy.
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
    title: "2. Information We Collect",
    content: (
      <>
        <p>We collect the following categories of personal information:</p>

        {/*
          Every line on this page must describe data the Platform actually
          collects. It previously listed a "student or staff ID number" and
          enrolment records pulled from a learning management system; neither
          exists — there is no such column in the schema and no such integration.
          A privacy policy that overstates collection is a factual misstatement
          about the thing users rely on it for, so it is corrected here rather
          than left until the surrounding copy is reworked.
        */}
        <h3 className="text-ink text-[13px] font-medium mt-4 mb-2">2.1 Information You Provide</h3>
        <ul>
          <li>Name and email address</li>
          <li>Profile photo (if uploaded voluntarily)</li>
          <li>
            Optional profile details you choose to add — biography, country,
            occupation, date of birth, and time zone
          </li>
          <li>Code submissions and programming activity within the Platform</li>
          <li>Messages and queries submitted to the VoidCode AI tutor</li>
          <li>Feedback and support communications</li>
        </ul>

        <h3 className="text-ink text-[13px] font-medium mt-4 mb-2">2.2 Information Collected Automatically</h3>
        <ul>
          <li>Device type, operating system, and browser information</li>
          <li>IP address and approximate geographic location</li>
          <li>Session data, page views, and interaction logs</li>
          <li>Performance metrics and error reports</li>
          <li>Authentication tokens and session identifiers</li>
        </ul>

        <h3 className="text-ink text-[13px] font-medium mt-4 mb-2">2.3 Information from Third Parties</h3>
        <ul>
          <li>
            Authentication data from Microsoft or Google when you use OAuth sign-in (name, email,
            and profile photo, subject to those providers&apos; privacy policies)
          </li>
        </ul>
        <p>
          We do not receive enrolment records, academic transcripts, or data
          from any learning management system.
        </p>
      </>
    ),
  },
  {
    id: "how-we-use",
    title: "3. How We Use Your Information",
    content: (
      <>
        <p>We use your personal information for the following purposes:</p>
        <ul>
          <li>To authenticate your identity and manage your account</li>
          <li>To deliver personalised AI-assisted tutoring and learning feedback</li>
          <li>To track your course progress and generate completion records</li>
          <li>To improve the accuracy and quality of the VoidCode AI model</li>
          <li>To detect, investigate, and prevent fraud, abuse, or security incidents</li>
          <li>To send service notifications, updates, and administrative messages</li>
          <li>To comply with legal obligations and VoidCode's internal policies</li>
          <li>To conduct anonymised research and analysis on learning outcomes</li>
        </ul>
        <p>
          We will not use your personal information for purposes beyond those listed above without
          your explicit consent, unless required by law.
        </p>
      </>
    ),
  },
  {
    id: "ai-data",
    title: "4. VoidCode AI & Your Data",
    content: (
      <>
        <p>
          Interactions with the VoidCode AI — including questions asked, code submitted, and
          conversation history — may be retained and used to:
        </p>
        <ul>
          <li>Provide contextual, personalised tutoring responses</li>
          <li>Analyse aggregate learning patterns to improve the AI model</li>
        </ul>
        <p>
          Individual AI conversations are not shared with other users or external parties.
          Conversations may be reviewed by authorised VoidCode staff for quality assurance
          and safety monitoring.
        </p>
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3">
          <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-2" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <p className="text-[12px] leading-relaxed text-ink-2">
            Do not include sensitive personal information (e.g. passwords, financial data, health information) in your VoidCode AI conversations.
          </p>
        </div>
      </>
    ),
  },
  {
    id: "disclosure",
    title: "5. Disclosure of Information",
    content: (
      <>
        <p>
          We do not sell, rent, or trade your personal information. We may disclose your
          information to:
        </p>
        <ul>
          <li>
            <strong className="text-ink-2">Service providers</strong> — third-party vendors
            who assist in operating the Platform (e.g. cloud hosting, authentication), bound by
            confidentiality agreements
          </li>
          <li>
            <strong className="text-ink-2">VoidCode staff</strong> — authorised personnel on
            a need-to-know basis
          </li>
          <li>
            <strong className="text-ink-2">Legal authorities</strong> — where required by law,
            court order, or to protect the rights and safety of users or the public
          </li>
          <li>
            <strong className="text-ink-2">Successors</strong> — in the event of a merger,
            acquisition, or transfer of assets, subject to equivalent privacy protections
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "data-retention",
    title: "6. Data Retention",
    content: (
      <>
        <p>We retain your personal information for as long as necessary to:</p>
        <ul>
          <li>Provide and improve the Platform services</li>
          <li>Comply with our legal and regulatory obligations</li>
          <li>Resolve disputes and enforce our agreements</li>
        </ul>
        <p>
          Upon account deletion or graduation, your personal profile data is deleted within
          <strong className="text-ink-2"> 90 days</strong>. Anonymised learning data (code
          submissions, performance metrics) may be retained indefinitely for research purposes.
          Authentication logs are retained for up to <strong className="text-ink-2">12 months</strong>.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "7. Security",
    content: (
      <>
        <p>
          We implement industry-standard technical and organisational measures to protect your
          personal information, including:
        </p>
        <ul>
          <li>Encryption of data in transit using TLS 1.2+</li>
          <li>Encryption of sensitive data at rest using AES-256</li>
          <li>Role-based access control limiting internal access to authorised personnel</li>
          <li>Regular security assessments and vulnerability scanning</li>
          <li>Multi-factor authentication for administrative access</li>
        </ul>
        <p>
          While we take reasonable steps to protect your data, no method of electronic storage
          or transmission is 100% secure. We cannot guarantee absolute security and encourage
          you to use strong, unique passwords and secure network connections.
        </p>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "8. Your Privacy Rights",
    content: (
      <>
        <p>Under the Australian Privacy Principles, you have the right to:</p>
        <ul>
          <li>
            <strong className="text-ink-2">Access</strong> — request a copy of the personal
            information we hold about you
          </li>
          <li>
            <strong className="text-ink-2">Correction</strong> — request correction of
            inaccurate or incomplete information
          </li>
          <li>
            <strong className="text-ink-2">Deletion</strong> — request deletion of your
            account and associated personal data (subject to legal retention obligations)
          </li>
          <li>
            <strong className="text-ink-2">Opt-out</strong> — withdraw consent for optional
            data uses such as AI model training
          </li>
          <li>
            <strong className="text-ink-2">Complaint</strong> — lodge a complaint with the
            Office of the Australian Information Commissioner (OAIC) if you believe your privacy
            rights have been violated
          </li>
        </ul>
        <p>
          To exercise any of these rights, please contact our Privacy Officer at{" "}
          <a href="mailto:privacy@swin.edu.au" className="text-ink hover:text-ink transition-colors">
            privacy@swin.edu.au
          </a>
          . We will respond within 30 days.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "9. Cookies & Tracking",
    content: (
      <>
        <p>The Platform uses the following types of cookies and local storage:</p>
        <div className="mt-3 overflow-hidden rounded-lg border border-line">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-void-2 border-b border-line">
                <th className="text-left px-4 py-2.5 text-ink-2 font-medium">Type</th>
                <th className="text-left px-4 py-2.5 text-ink-2 font-medium">Purpose</th>
                <th className="text-left px-4 py-2.5 text-ink-2 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {[
                ["Session", "Authentication state & user session management", "Session"],
                ["Preferences", "UI theme, language, and layout preferences", "1 year"],
                ["Analytics", "Anonymised usage analytics for platform improvement", "90 days"],
                ["Security", "CSRF tokens and anti-fraud measures", "Session"],
              ].map(([type, purpose, duration]) => (
                <tr key={type} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-2.5 text-ink-2 font-medium">{type}</td>
                  <td className="px-4 py-2.5 text-ink-3">{purpose}</td>
                  <td className="px-4 py-2.5 text-ink-3">{duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3">
          You may configure your browser to refuse cookies, however this may affect the
          functionality of the Platform.
        </p>
      </>
    ),
  },
  {
    id: "third-party",
    title: "10. Third-Party Services",
    content: (
      <>
        <p>The Platform integrates with the following third-party services:</p>
        <ul>
          <li>
            <strong className="text-ink-2">Microsoft Azure AD</strong> — OAuth authentication
            (governed by{" "}
            <a href="https://privacy.microsoft.com" target="_blank" rel="noopener noreferrer" className="text-ink hover:text-ink transition-colors">
              Microsoft Privacy Statement
            </a>
            )
          </li>
          <li>
            <strong className="text-ink-2">Google OAuth</strong> — authentication for Google
            accounts (governed by{" "}
            <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" className="text-ink hover:text-ink transition-colors">
              Google Privacy Policy
            </a>
            )
          </li>
        </ul>
        <p>
          We are not responsible for the privacy practices of third-party services. We encourage
          you to review their privacy policies independently.
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
          We may update this Privacy Policy from time to time to reflect changes in our practices,
          technology, or legal requirements. We will notify you of material changes by:
        </p>
        <ul>
          <li>Posting the updated Policy on this page with a revised "Last Updated" date</li>
          <li>Sending a notification to your registered email address for significant changes</li>
        </ul>
        <p>
          We encourage you to review this Policy periodically. Your continued use of the Platform
          after changes become effective constitutes acceptance of the revised Policy.
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
    <div className="max-w-6xl mx-auto">

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
              How VoidCode AI collects, uses, and protects your personal information.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-[11px] text-ink-3/60">Last updated</span>
            <span className="text-[12px] text-ink-2 font-medium">1 January 2025</span>
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
