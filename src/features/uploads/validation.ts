/**
 * What is checked before the name of a new video is sent: the obvious mistakes only. The server
 * has the real rules (length, reserved names, a name that exists) and says so in its own sentence.
 */
export function videoNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Give the video a name.";
  if (/[/\\]/.test(trimmed)) return "A name cannot contain a slash.";
  return null;
}
