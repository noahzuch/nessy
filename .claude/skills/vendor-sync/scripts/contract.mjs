// The script contract: the bottom module every other vendor-sync script builds on.
//
// Every run prints exactly one JSON object to stdout and exits 0 (the script ran),
// 1 (the input was wrong or incomplete; correct it and re-run) or 2 (stop; the
// recourse is the user's). `run` is the only writer of stdout and the only place the
// exit code is set; every other failure is a thrown `ScriptError`. stderr carries
// git's own output and nothing else. The exit code goes through `process.exitCode`,
// never `process.exit()`, so a large object is never truncated on a pipe.

export const EXIT = Object.freeze({ OK: 0, FIX: 1, STOP: 2 });

// A full object id: 40 lowercase hex digits.
export const HEX40 = /^[0-9a-f]{40}$/;

// Pure: a JSON object, not null and not an array.
export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ScriptError extends Error {
  constructor(exit, message, { hint, data, gitStderr } = {}) {
    super(message);
    this.name = "ScriptError";
    this.exit = exit;
    this.hint = hint;
    this.data = data;
    this.gitStderr = gitStderr;
  }
}

export function fail(exit, message, opts) {
  throw new ScriptError(exit, message, opts);
}

export function run(main) {
  let obj;
  let exit = EXIT.OK;
  try {
    obj = main();
  } catch (err) {
    if (err instanceof ScriptError) {
      if (err.gitStderr) {
        process.stderr.write(err.gitStderr.endsWith("\n") ? err.gitStderr : err.gitStderr + "\n");
      }
      const error = { message: err.message };
      if (err.hint !== undefined) error.hint = err.hint;
      if (err.data !== undefined) error.data = err.data;
      obj = { error };
      exit = err.exit;
    } else {
      obj = { error: { message: err instanceof Error ? err.message : String(err) } };
      exit = EXIT.STOP;
    }
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exitCode = exit;
}

// Pure and never throws: the entry script decides what to do with `problems`.
export function parseArgv(argv, spec) {
  const positionals = [];
  const flags = {};
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    const inline = eq === -1 ? undefined : tok.slice(eq + 1);
    if (spec.bool.includes(name)) {
      if (inline === undefined) flags[name] = true;
      else problems.push(`--${name} takes no value`);
    } else if (spec.value.includes(name)) {
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          problems.push(`missing value for --${name}`);
        } else {
          flags[name] = next;
          i++;
        }
      }
    } else {
      problems.push(`unknown flag: --${name}`);
    }
  }
  return { positionals, flags, problems };
}

// A function that fails 1 with `message` and the script's usage as hint.
export function usageFailure(usage) {
  return (message) => fail(EXIT.FIX, message, { hint: usage });
}

// `parseArgv`, failing 1 with every problem and the usage when there is any.
export function parseArgvOrFail(argv, spec, usage) {
  const { positionals, flags, problems } = parseArgv(argv, spec);
  if (problems.length) usageFailure(usage)(problems.join("; "));
  return { positionals, flags };
}

// Which resume `--continue` or `--abort` asks for, or null for a start. A resume takes only
// <dir>: another positional count or any of the start's `startFlags` fails 1 with the usage.
export function resumeMode(positionals, flags, startFlags, usage) {
  if (!flags.continue && !flags.abort) return null;
  const fail1 = usageFailure(usage);
  if (flags.continue && flags.abort) fail1("--continue and --abort exclude each other");
  const mode = flags.continue ? "continue" : "abort";
  if (positionals.length !== 1 || startFlags.some((f) => flags[f] !== undefined)) {
    fail1(`--${mode} takes only <dir>`);
  }
  return mode;
}
