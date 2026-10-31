/** HTTP status for an error thrown by lib/profiles (create, manage, switch). */
export function profileErrorStatus(message: string): number {
  if (/^copySettingsFrom profile not found|^schemaFrom/.test(message)) return 400;
  if (/not found/.test(message)) return 404;
  if (/already exists|active profile|last profile|cannot delete/.test(message)) return 409;
  if (/invalid|cannot be empty/.test(message)) return 400;
  return 500;
}
