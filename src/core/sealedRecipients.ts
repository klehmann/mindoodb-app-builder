/**
 * Reading who can open a sealed document, from its `_encryptFor` map.
 *
 * The same rules TeamEdit uses for its document properties: names compare
 * case-insensitively and in either canonical (`cn=Ann/o=Acme`) or abbreviated
 * (`Ann/Acme`) form, removed readers and device keys do not count, and the directory's
 * own spelling of a name wins when it is shown.
 */
import { abbreviateCanonicalName } from "mindoodb-app-sdk";

interface EncryptForEntry {
  kind?: string;
  removedAt?: number;
  label?: string;
}

export function recipientNamesEqual(left: string, right: string): boolean {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  return abbreviateCanonicalName(left).toLowerCase() === abbreviateCanonicalName(right).toLowerCase();
}

/** Every person who can currently read the document, the author included. */
export function activeRecipients(data: Record<string, unknown> | null | undefined): string[] {
  const raw = data?._encryptFor;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  return Object.entries(raw as Record<string, EncryptForEntry>)
    .filter(
      ([, entry]) =>
        entry && typeof entry === "object" && !entry.removedAt && entry.kind !== "device",
    )
    .map(([id, entry]) => entry.label || id.split("#")[0]!);
}

/** The readers besides `self`, who is on the list anyway. */
export function otherRecipients(
  data: Record<string, unknown> | null | undefined,
  self: string,
): string[] {
  return activeRecipients(data).filter((name) => !self.trim() || !recipientNamesEqual(name, self));
}

export function recipientDiff(
  current: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  return {
    added: next.filter((name) => !current.some((existing) => recipientNamesEqual(existing, name))),
    removed: current.filter((name) => !next.some((existing) => recipientNamesEqual(existing, name))),
  };
}

/** Show a stored name the way the directory spells it, shortened. */
export function displayRecipient(name: string, directoryUsers: readonly string[]): string {
  const resolved = directoryUsers.find((user) => recipientNamesEqual(user, name)) ?? name;
  return abbreviateCanonicalName(resolved) || resolved;
}
