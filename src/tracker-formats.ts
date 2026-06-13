export const MOD_EXTENSIONS = [".mod"];

export function extOf(filePath: string): string {
  const i = filePath.lastIndexOf(".");
  return i >= 0 ? filePath.slice(i).toLowerCase() : "";
}

export function isTrackerFile(fileName: string): boolean {
  return MOD_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext));
}
