/** Vite's `?raw` suffix, used to carry `runtime/bootstrap.py` inside the bundle. */
declare module "*.py?raw" {
  const source: string;
  export default source;
}
