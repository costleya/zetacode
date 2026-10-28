export function normalizePathSeparators(path: string): string {
  return path.replaceAll("\\", "/");
}
