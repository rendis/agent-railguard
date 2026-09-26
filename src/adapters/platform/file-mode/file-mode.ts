/**
 * Whether the file system carries POSIX permission bits. Windows does not: Node reports 0o666 or
 * 0o444 for files and never an executable bit, so modes there are neither observable nor settable.
 */
export const posixFileModes = process.platform !== "win32";

/** Whether an observed mode satisfies the expected one where modes exist at all. */
export function sameFileMode(observed: number, expected: number, posix: boolean = posixFileModes): boolean {
  return !posix || observed === expected;
}
