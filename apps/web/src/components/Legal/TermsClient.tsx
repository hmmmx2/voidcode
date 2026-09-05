"use client";

import { useState } from "react";
import Link from "next/link";

// ── Types ──────────────────────────────────────────────────────────────────

interface Section {
  id: string;
  title: string;
  content: React.ReactNode;
}

// ── Table of Contents ──────────────────────────────────────────────────────

const SECTIONS: Section[] = [
  {
    id: "acceptance",
    title: "1. Acceptance of Terms",
    content: (
      <>
        <p>
          By accessing or using the VoidCode AI platform ("Platform"), you agree to be bound
          by these Terms of Use ("Terms"). If you do not agree to these Terms, you must not access
          or use the Platform.
        </p>
        <p>
          These Terms constitute a legally binding agreement between you and VoidCode AI ("VoidCode", "we", "our", or "us"). Your continued use of the Platform
          following any updates to these Terms constitutes acceptance of those changes.
        </p>
      </>
    ),
  },
  {
    id: "eligibility",
    title: "2. Eligibility",
    content: (
      <>
        {/*
          Eligibility described an enrolled student body, academic staff and an
          administration that grants access. None of that exists — VoidCode is
          an open interview-preparation platform with self-service sign-up, and
          there is no enrolment check anywhere in the codebase. Terms that gate
          on a status the product never verifies are unenforceable and
          misleading in both directions.
        */}
        <p>The Platform is intended for use by:</p>
        <ul>
          <li>Engineers preparing for machine learning and systems interviews</li>
          <li>Individuals with a registered VoidCode AI account</li>
        </ul>
        <p>
          You must be at least 16 years of age to use the Platform. By using the Platform, you
          represent and warrant that you meet all eligibility requirements.
        </p>
      </>
    ),
  },
  {
    id: "account",
    title: "3. Account Responsibilities",
    content: (
      <>
        <p>
          You are responsible for maintaining the confidentiality of your account credentials and
          for all activities that occur under your account. You agree to:
        </p>
        <ul>
          <li>Provide accurate and complete information when creating your account</li>
          <li>Notify us immediately of any unauthorised use of your account</li>
          <li>Not share your account credentials with any third party</li>
          <li>Not create multiple accounts for the same individual</li>
          <li>Log out of your account at the end of each session on shared devices</li>
        </ul>
        <p>
          VoidCode reserves the right to suspend or terminate accounts that violate these Terms
          or engage in any prohibited activity.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "4. Acceptable Use",
    content: (
      <>
        <p>You agree to use the Platform only for lawful, educational purposes. You must not:</p>
        <ul>
          <li>
            Share, publish, or resell Platform content, including problem
            statements, hidden test cases, and reference solutions
          </li>
          <li>Attempt to reverse-engineer, decompile, or disassemble the Platform</li>
          <li>Introduce malicious code, viruses, or harmful data to the Platform</li>
          <li>Scrape, harvest, or extract data from the Platform without prior written consent</li>
          <li>Use automated tools or bots to interact with the Platform</li>
          <li>Impersonate any person or entity, or misrepresent your affiliation</li>
          <li>Attempt to gain unauthorised access to any part of the Platform or its systems</li>
          <li>Use the Platform in any manner that could damage, disable, or impair its operation</li>
        </ul>
        {/*
          The original sentence referred violations to "VoidCode's academic
          integrity or disciplinary processes". There is no such process, and
          threatening a procedure that does not exist is both unenforceable and
          a claim the product cannot back. Account termination is the remedy
          that actually exists.
        */}
        <p>
          Violations of this section may result in immediate suspension or termination of your
          account.
        </p>
      </>
    ),
  },
  {
    id: "ai-usage",
    title: "5. AI-Assisted Learning",
    content: (
      <>
        <p>
          The Platform uses artificial intelligence to provide Socratic-style tutoring and
          programming guidance. By using the AI features, you acknowledge that:
        </p>
        <ul>
          <li>
            AI-generated responses are educational aids and may not always be perfectly accurate
          </li>
          <li>
            You remain solely responsible for verifying information and the correctness of your
            submissions
          </li>
          <li>
            Conversations with the VoidCode AI may be logged and used to improve the Platform
          </li>
          <li>
            The AI is designed to guide, not to provide direct answers — attempting to coerce a
            complete solution out of it defeats the purpose of the Platform
          </li>
        </ul>
        <p>
          VoidCode AI makes no warranty that AI-generated content is error-free or
          suitable for any specific purpose beyond educational guidance.
        </p>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "6. Intellectual Property",
    content: (
      <>
        <p>
          All content on the Platform — including but not limited to course materials, problem sets,
          software, logos, and design — is the property of VoidCode AI or
          its licensors and is protected by Australian and international intellectual property laws.
        </p>
        <p>
          You are granted a limited, non-exclusive, non-transferable licence to access and use the
          Platform content solely for your personal educational purposes. You must not:
        </p>
        <ul>
          <li>Reproduce, distribute, or publicly display Platform content without authorisation</li>
          <li>Create derivative works based on Platform content</li>
          <li>Remove or alter any copyright or proprietary notices</li>
        </ul>
        <p>
          Code you write and submit through the Platform remains your intellectual property,
          however you grant VoidCode a non-exclusive licence to use submitted code for assessment
          and platform improvement purposes.
        </p>
      </>
    ),
  },
  {
    id: "privacy",
    title: "7. Privacy",
    content: (
      <>
        <p>
          Your use of the Platform is also governed by our{" "}
          <Link href="/privacy" className="text-ink hover:text-ink underline underline-offset-2 transition-colors">
            Privacy Policy
          </Link>
          , which is incorporated into these Terms by reference. By using the Platform, you consent
          to the collection and use of your data as described in the Privacy Policy.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "8. Disclaimers",
    content: (
      <>
        <p>
          The Platform is provided on an "as is" and "as available" basis without warranties of
          any kind, either express or implied. VoidCode AI does not warrant that:
        </p>
        <ul>
          <li>The Platform will be uninterrupted, error-free, or secure</li>
          <li>Any defects will be corrected</li>
          <li>The Platform is free of viruses or other harmful components</li>
          <li>Results obtained from the Platform will be accurate or reliable</li>
        </ul>
        <p>
          To the fullest extent permitted by law, VoidCode AI disclaims all warranties,
          express or implied, including merchantability, fitness for a particular purpose, and
          non-infringement.
        </p>
      </>
    ),
  },
  {
    id: "limitation",
    title: "9. Limitation of Liability",
    content: (
      <>
        <p>
          To the maximum extent permitted by applicable law, VoidCode AI shall not be
          liable for any indirect, incidental, special, consequential, or punitive damages
          arising from your use of, or inability to use, the Platform.
        </p>
        <p>
          In no event shall VoidCode's total liability to you for all claims arising from or
          relating to these Terms or the Platform exceed the amount you have paid to VoidCode
          (if any) in the twelve months preceding the claim.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "10. Changes to Terms",
    content: (
      <>
        <p>
          VoidCode AI reserves the right to modify these Terms at any time. We will
          notify users of material changes by posting an updated version on the Platform with
          a revised "Last Updated" date.
        </p>
        <p>
          Your continued use of the Platform after changes become effective constitutes your
          acceptance of the revised Terms. If you do not agree to the updated Terms, you must
          discontinue use of the Platform.
        </p>
      </>
    ),
  },
  {
    id: "governing-law",
    title: "11. Governing Law",
    content: (
      <>
        <p>
          These Terms are governed by the laws of Victoria, Australia. You agree to submit to the
          exclusive jurisdiction of the courts located in Victoria for the resolution of any
          disputes arising under these Terms.
        </p>
      </>
    ),
  },
  {
    id: "contact",
    title: "12. Contact Us",
    content: (
      <>
        <p>
          If you have any questions about these Terms, please contact us:
        </p>
        <div className="mt-3 p-4 rounded-lg bg-void-2 border border-line space-y-1">
          <p className="text-ink font-medium">VoidCode AI</p>
          <p>Digital Learning &amp; Innovation Office</p>
          <p>John Street, Hawthorn VIC 3122, Australia</p>
          <p>
            Email:{" "}
            <a href="mailto:digitallearning@swin.edu.au" className="text-ink hover:text-ink transition-colors">
              digitallearning@swin.edu.au
            </a>
          </p>
        </div>
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
      <div className="text-[13px] text-ink-2 leading-relaxed space-y-3 [&_ul]:mt-2 [&_ul]:ml-4 [&_ul]:space-y-1.5 [&_ul]:list-disc [&_ul]:list-outside [&_ul]:marker:text-ink-3/60">
        {section.content}
      </div>
    </section>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function TermsClient() {
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
          <span className="text-[11px] text-ink-2">Terms of Use</span>
        </div>

        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-ink mb-2">Terms of Use</h1>
            <p className="text-sm text-ink-3">
              Please read these terms carefully before using the VoidCode AI platform.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-[11px] text-ink-3/60">Last updated</span>
            <span className="text-[12px] text-ink-2 font-medium">1 January 2025</span>
          </div>
        </div>

        {/* Effective notice banner */}
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-line-strong bg-void-2 px-4 py-3">
          <svg className="w-4 h-4 text-ink mt-0.5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
          </svg>
          <p className="text-[12px] text-ink/80 leading-relaxed">
            These Terms of Use are effective from <strong className="text-ink">1 January 2025</strong> and apply to all users of the VoidCode AI platform. By continuing to use the Platform, you agree to be bound by these Terms.
          </p>
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
              href="/privacy"
              className="flex items-center gap-2 text-[12px] text-ink-3 hover:text-ink transition-colors group"
            >
              <svg className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" viewBox="0 0 14 14" fill="none">
                <path d="M9 2L4 7L9 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Privacy Policy
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
