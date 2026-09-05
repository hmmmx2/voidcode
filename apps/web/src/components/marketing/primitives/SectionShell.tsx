import { cn } from "@/lib/utils";

/**
 * Page container. One source of truth for the horizontal rhythm so sections
 * cannot drift apart from each other.
 */
export function Container({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1240px] px-6 lg:px-10", className)}>
      {children}
    </div>
  );
}

/**
 * A page section.
 *
 * `divider` draws the hairline that separates one section from the next. This is
 * the page's only separator — sections never change background colour to mark a
 * boundary. On a monochrome page fill is the scarcest axis of contrast, and
 * spending it on structure leaves nothing for emphasis.
 */
export function Section({
  id,
  className,
  divider = true,
  children,
}: {
  id?: string;
  className?: string;
  divider?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "relative py-24 lg:py-40",
        divider && "border-t border-line",
        className
      )}
    >
      {children}
    </section>
  );
}

/**
 * Uppercase letterspaced label. Scale's device, and the page's most repeated
 * small element — worth a component so the tracking never drifts.
 */
export function Eyebrow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "text-xs font-medium uppercase tracking-[0.22em] text-ink-3",
        className
      )}
    >
      {children}
    </p>
  );
}

/** Section heading. Paired with `Eyebrow` at a fixed 20px gap. */
export function SectionHeading({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <h2 className={cn("mt-5 max-w-[20ch] text-h2 text-ink", className)}>{children}</h2>
  );
}

/** Lead paragraph. Sits 24px under a heading, 56px above content. */
export function Lead({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p className={cn("mt-6 max-w-[52ch] text-lg leading-relaxed text-ink-2", className)}>
      {children}
    </p>
  );
}

/**
 * Monospace metadata label — the small technical strings (`[TEACHING]`,
 * `d_k`, stack names) that carry this product's credibility.
 */
export function MonoLabel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "font-mono text-xs tracking-[0.02em] text-ink-3",
        className
      )}
    >
      {children}
    </span>
  );
}
