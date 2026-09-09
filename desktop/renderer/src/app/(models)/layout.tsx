import { AppBackdrop } from "@/components/app";

/**
 * Shell for `/models`.
 *
 * The same shape as `(profile)/layout.tsx` minus the sidebar — see `(homepage)/layout.tsx`
 * for why `isolate` is load-bearing and why the scroll container stays on `<main>`.
 *
 * No sidebar because there is one page here. `/profile` has one because it has siblings
 * (Terms, Privacy); a rail with a single item is chrome pretending to be navigation.
 */
export default function ModelsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate flex h-full flex-col overflow-hidden bg-void-0 text-ink-2">
      <AppBackdrop />

      <noscript>
        <style>{`.reveal { opacity: 1; transform: none; filter: none; }`}</style>
      </noscript>

      <main className="relative z-10 flex flex-1 flex-col overflow-y-auto">
        <div className="flex-1 px-6 py-8 lg:px-10">{children}</div>
      </main>
    </div>
  );
}
