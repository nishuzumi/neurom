// editor/virtual-modules.d.ts — the virtual modules of vite.config.ts, for vue-tsc.
/** the text of one classic script that defines the global `viem` (vite.config.ts viemGlobal) */
declare module 'virtual:viem-global' {
  const source: string;
  export default source;
}
