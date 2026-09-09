import type {
  ComponentPropsWithoutRef,
  ComponentType,
  ElementType,
  ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The rendered tag, widened for JSX.
 *
 * `ElementType` is a union of every intrinsic and component type, and JSX
 * resolves a union's props to their *intersection* — which for `children`
 * across all of them is `never`, so `<Tag>{children}</Tag>` fails to compile
 * even though every concrete instantiation is fine. The public generic on each
 * component is what actually type-checks the call site; this cast only exists
 * to get past that intersection inside the implementation.
 */
type AnyTag = ComponentType<Record<string, unknown> & { children?: ReactNode }>;

/**
 * The app's card. There was not one before — every panel across seven routes
 * picked its own fill and its own border, which is how the codebase ended up
 * with `#111114`, `#0D0D10`, `#0f0f12` and `#111111` all meaning "panel".
 *
 * SURFACES SEPARATE BY HAIRLINE, NOT BY FILL. That is the house rule the
 * landing page is built on and the single biggest reason it reads as calm.
 * `tone="flat"` — transparent, one hairline — is therefore the default, and
 * `raised` is for the few places a card genuinely needs to sit forward.
 *
 * Glass is a separate export rather than a `tone`, because it is not another
 * step on the same scale: it costs per-frame compositing, it only works over
 * `AppBackdrop`, and it is approved for exactly five surfaces in this app. A
 * `tone="glass"` variant would make it a free-looking choice in autocomplete.
 */

type SurfaceOwnProps = {
  /** `flat` (default) is transparent; `raised` fills to `void-2`. */
  tone?: "flat" | "raised";
  radius?: "card" | "panel";
  bordered?: boolean;
  /**
   * Hover and keyboard-focus affordances for a card that is itself a control.
   *
   * This does NOT make the element interactive — pass `as="button"` or
   * `as={Link}` too. The distinction matters: the two course cards this
   * replaces were clickable `<div>`s with no role, no `tabIndex` and no key
   * handler, so the entire course list was unreachable by keyboard and
   * invisible to a screen reader as a link. Styling alone would have kept
   * that bug while making it look deliberate.
   */
  interactive?: boolean;
  className?: string;
  children?: ReactNode;
};

type SurfaceProps<T extends ElementType> = SurfaceOwnProps & {
  as?: T;
} & Omit<ComponentPropsWithoutRef<T>, keyof SurfaceOwnProps | "as">;

const RADIUS = {
  card: "rounded-2xl",
  panel: "rounded-panel",
} as const;

export function Surface<T extends ElementType = "div">({
  as,
  tone = "flat",
  radius = "card",
  bordered = true,
  interactive = false,
  className,
  children,
  ...rest
}: SurfaceProps<T>) {
  const Tag = (as ?? "div") as unknown as AnyTag;

  return (
    <Tag
      className={cn(
        RADIUS[radius],
        bordered && "border border-line",
        tone === "raised" && "bg-void-2",
        interactive && [
          "cursor-pointer text-left transition-colors duration-200 ease-void",
          "hover:border-line-strong hover:bg-void-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink",
          "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0",
        ],
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

type GlassProps<T extends ElementType> = {
  as?: T;
  radius?: "card" | "panel" | "pill";
  className?: string;
  children?: ReactNode;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "radius" | "className" | "children">;

const GLASS_RADIUS = {
  card: "rounded-2xl",
  panel: "rounded-panel",
  pill: "rounded-full",
} as const;

/**
 * Frosted glass. Approved for five surfaces only: the top nav, the three
 * dropdown menus, the avatar modal, the dashboard hero and the course header.
 *
 * THE `@supports` ORDER IS INVERTED ON PURPOSE, AND GETTING IT BACKWARDS IS A
 * LEGIBILITY BUG, NOT A COSMETIC ONE.
 *
 * Near-opaque black is the *default*; the translucent white film is the
 * enhancement layered on only where `backdrop-filter` exists. Written the
 * natural way round — white film by default, opacity as the fallback — a
 * browser without `backdrop-filter` renders a 4.5% white haze over whatever is
 * scrolling underneath, with no blur to separate them. That is unreadable.
 * `MarketingNav` makes the same inversion for the same reason.
 *
 * `supports-[…]:` compiles to a real `@supports` block, which also means
 * Lightning CSS cannot collapse the fallback away — it has silently deleted
 * two-declaration fallbacks in this project before.
 *
 * `.glass-edge` supplies the 1px hairline that is brighter along the top, the
 * detail that separates glass from a translucent grey box. It is a different
 * class from the auth pages' `.glass-panel` specifically because that one sets
 * `background` unconditionally and would override the opaque default above.
 *
 * Never raise the blur past `xl` (24px). These surfaces sit inside a scroll
 * container, so their backdrops resample every frame the user scrolls.
 */
export function GlassSurface<T extends ElementType = "div">({
  as,
  radius = "card",
  className,
  children,
  ...rest
}: GlassProps<T>) {
  const Tag = (as ?? "div") as unknown as AnyTag;

  return (
    <Tag
      className={cn(
        "glass-edge relative",
        GLASS_RADIUS[radius],
        "bg-void-0/85",
        "supports-[backdrop-filter]:bg-white/[0.045]",
        "supports-[backdrop-filter]:backdrop-blur-xl",
        "supports-[backdrop-filter]:backdrop-saturate-150",
        "shadow-[0_24px_70px_-40px_rgb(0_0_0/0.9)]",
        className
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
