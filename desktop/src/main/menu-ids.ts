/**
 * The menu bar's top-level entries — now a re-export.
 *
 * These moved to `src/shared/commands.ts` when the command table landed, because the renderer
 * needs them too and was keeping its own copy (`MENUS` in `Workbench.tsx`). Two lists of the
 * same eight labels in two processes is exactly the drift this file's original comment was
 * trying to prevent, one layer up.
 *
 * The re-export stays rather than updating every import, because the reason this module exists
 * is unchanged and worth preserving: `ipc/contract.ts` validates `menu:popup` against
 * `MENU_IDS`, and `contract.ts` is imported by `windows.ts`, which `menu.ts` imports. The
 * shared module is import-free for the same reason, so the cycle is still closed.
 */
export { MENU_IDS, MENU_LABELS, type MenuId } from "../shared/commands.js";
