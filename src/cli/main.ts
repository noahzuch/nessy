import { dispatch } from "./index.js";

// All human-facing output goes to stderr (spec §6 — stdout is reserved).
const print = (msg: string) => process.stderr.write(msg + "\n");

const code = dispatch(process.argv.slice(2), print, process.cwd());
process.exit(code);
