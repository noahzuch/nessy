export function nessyRemove(
  print: (msg: string) => void,
  cwd: string,
  _flags: string[],
): number {
  print(`[nessy remove — noop] would delete .nessy/ at ${cwd}`);
  return 0;
}
