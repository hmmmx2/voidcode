/**
 * The workbench's destinations.
 *
 * Two, not five. `Dashboard | Problems | Interviews | Code` as peer items in a top nav
 * flattened two different kinds of thing onto one row: three views of the study product,
 * and an entire second product. The activity bar carries the products; the section sidebar
 * carries the views inside one.
 */

export type DestinationId = "prep" | "code";

export interface Section {
  href: string;
  label: string;
  /** Right-aligned count. The only numbers in the rail, and they earn their place. */
  countKey?: "problems" | "interviews" | "projects";
}

export interface Destination {
  id: DestinationId;
  label: string;
  /** Route entered when the destination is selected from the rail. */
  home: string;
  /** Every route belonging to this destination, for deciding which icon is lit. */
  match: string[];
  sections: Section[];
}

/**
 * The IDE first, and the order is the claim.
 *
 * The rail is read top-down, and whichever sits at the top is what the app is *for*. Interview
 * Prep was there because it shipped first, not because it is the product — and `/` opened onto
 * its dashboard, so a developer launching a code editor met a list of exercises.
 *
 * `/profile` and `/account` belong to neither. They manage the local profile and the optional
 * VoidCode account for the whole application rather than a view inside either product, so they
 * are reached from the menu bar and appear in no section list. See `isAccountRoute`.
 */
export const DESTINATIONS: Destination[] = [
  {
    id: "code",
    label: "Code",
    home: "/build",
    match: ["/build"],
    // The IDE's left panel is the file tree, not a section list — so no sections here, and
    // the sidebar yields that slot to the destination rather than showing an empty rail.
    sections: [],
  },
  {
    id: "prep",
    label: "Interview Prep",
    home: "/homepage",
    match: ["/homepage", "/problems", "/interviews", "/projects", "/research"],
    sections: [
      { href: "/homepage", label: "Dashboard" },
      { href: "/problems", label: "Problems", countKey: "problems" },
      { href: "/interviews", label: "Interviews", countKey: "interviews" },
      { href: "/projects", label: "Projects", countKey: "projects" },
      /**
       * NO COUNT, and that is the one thing about this entry worth explaining.
       *
       * Every other section here counts something the application already knows: the problems,
       * questions and projects are content that ships in the bundle. The paper library lives on
       * our server, so a number beside "Research" would mean fetching the index to draw the
       * sidebar of every other page in the product — for a reader who never opened it. The
       * library is a network feature reached by an explicit action, and the rail has to stay
       * consistent with that.
       */
      { href: "/research", label: "Research" },
    ],
  },
];

/**
 * Account management, which belongs to the platform rather than to either product.
 *
 * It used to sit in Interview Prep's `match`, so editing your name lit the Interview Prep icon
 * and implied the profile was part of the study product. It is the same account whichever
 * surface you are on.
 *
 * Kept out of `BARE_ROUTES` deliberately: the window is frameless, and a bare route draws no
 * title bar — so a "platform" page reached that way would be one with no way to close the
 * window it opened in.
 */
export function isAccountRoute(pathname: string): boolean {
  // `/account` is the optional VoidCode account; `/profile` is the local profile. Both are the
  // platform's, and a product icon lighting up on either would be wrong in the same way.
  return pathname.startsWith("/profile") || pathname.startsWith("/account");
}

/**
 * The local model manager, which is also platform rather than product.
 *
 * Same reasoning as the account: the models on this machine serve the IDE and the study app
 * equally, and every `models:*` channel is `modes: BOTH`, so the page works from either kind
 * of window. Kept out of `BARE_ROUTES` for the same reason `/profile` is — a frameless window
 * with no title bar has no way to close itself.
 */
export function isModelsRoute(pathname: string): boolean {
  return pathname.startsWith("/models");
}

/**
 * Any route belonging to the platform rather than to a product.
 *
 * The shell asks this rather than asking about each route in turn: what it needs to know is
 * "should a product icon light up", and the answer for every platform page is no. Adding the
 * third such page should not mean finding four `||` chains.
 */
export function isPlatformRoute(pathname: string): boolean {
  return isAccountRoute(pathname) || isModelsRoute(pathname);
}

/** Which destination a route belongs to. Longest match wins, so `/problems/3` resolves. */
export function destinationForPath(pathname: string): Destination {
  for (const destination of DESTINATIONS) {
    if (destination.match.some((prefix) => pathname.startsWith(prefix))) return destination;
  }
  // The IDE, since it is now first. An unmatched route is more likely to be a code surface
  // than a study one, and `/` redirects there anyway.
  return DESTINATIONS[0]!;
}

/**
 * Routes that render without the workbench.
 *
 * `/` is a redirect stub that paints nothing, and the legal pages are documents rather than
 * tools — wrapping either in an activity bar and panel toggles would be costume.
 */
const BARE_ROUTES = ["/", "/terms", "/privacy"];

export function isBareRoute(pathname: string): boolean {
  return BARE_ROUTES.includes(pathname);
}
