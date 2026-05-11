// Wraps a value as a POSIX single-quoted shell argument. Single quotes inside
// are escaped via the `'\''` trick (close, escaped quote, reopen). Use for any
// untrusted value passed to ssh.execCommand.
export function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
