// Run a full project type-check whenever any TS file is staged.
// The function form omits the file list so `tsc` uses tsconfig.json
// (per-file `tsc` would lose project-wide type information).
export default {
  '**/*.ts': () => 'tsc --noEmit',
}
