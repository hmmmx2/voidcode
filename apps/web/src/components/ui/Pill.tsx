import Link from "next/link";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The product's only button.
 *
 * It lives in `ui/` rather than `marketing/primitives/` because it is no longer
 * the landing page's button — the logged-in app uses it too, and a workspace
 * toolbar importing its primary action from a directory called `marketing`
 * would be a lie about what the module is for.
 *
 * THERE IS NO SECOND BUTTON PRIMITIVE, AND THAT IS THE POINT.
 *
 * There used to be: `ui/button.tsx`, a CVA component whose base class carried
 * `focus-visible:ring-ring`. `--color-ring` resolves to green `#2e7d32`, so
 * *every* variant of it — including `ghost` — flashed green the moment a
 * keyboard user tabbed to it, and `variant="default"` was solid green outright.
 * Because `globals.css` uses `@theme inline`, Tailwind compiles the token's
 * declared value straight into the utility; there is no runtime variable left
 * for a scoped override to reach.
 *
 * Every would-be consumer had independently refused it, and three files carried
 * a comment explaining why, so it was imported by nothing at all. It has been
 * deleted. If you want a variant this component does not have, add it here —
 * do not reintroduce a competitor.
 */
const pill = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium " +
    "transition-[background-color,border-color,color,transform] duration-200 ease-void " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink " +
    "focus-visible:ring-offset-2 focus-visible:ring-offset-void-0 " +
    "disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        // The inverted primary. White is scarce on this page precisely so that
        // this one element reads as the single call to action.
        solid: "bg-ink text-void-0 hover:bg-ink/90 active:translate-y-px",
        outline:
          "border border-line-strong bg-transparent text-ink hover:border-ink-3 hover:bg-void-2",
        ghost: "bg-transparent text-ink-2 hover:text-ink hover:bg-void-2",
      },
      size: {
        sm: "h-8 px-4 text-xs",
        md: "h-10 px-5 text-sm",
        lg: "h-12 px-7 text-[0.9375rem]",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  }
);

type PillVariants = VariantProps<typeof pill>;

type PillAsLink = PillVariants & {
  href: string;
} & Omit<React.ComponentPropsWithoutRef<typeof Link>, "href" | "color">;

type PillAsButton = PillVariants & {
  href?: undefined;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

export type PillProps = PillAsLink | PillAsButton;

export function Pill({ variant, size, className, ...props }: PillProps) {
  const classes = cn(pill({ variant, size }), className);

  if (props.href !== undefined) {
    const { href, ...rest } = props as PillAsLink;
    return <Link href={href} className={classes} {...rest} />;
  }

  const { type, ...rest } = props as PillAsButton;
  return <button type={type ?? "button"} className={classes} {...rest} />;
}
