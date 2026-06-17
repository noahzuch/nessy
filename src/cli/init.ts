export function nessyInit(
  print: (msg: string) => void,
  cwd: string,
): number {
  print(`[nessy init — noop] would create .nessy/ at ${cwd}`);
  return 0;
}
