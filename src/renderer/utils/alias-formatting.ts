import type { SendAsAlias } from "../../shared/types";

/**
 * Format an alias as "Display Name <email>" or just "email".
 *
 * Falls back to `fallbackName` (the account's OAuth display name) only for the
 * primary/default alias. That's where the name lives on the OAuth profile
 * rather than in Gmail's send-as settings, which is common for Workspace
 * accounts. Secondary aliases without a display name are left bare on
 * purpose — they may be shared mailboxes (support@, team@) where the account
 * holder's personal name would be wrong.
 */
export function formatAlias(alias: SendAsAlias, fallbackName?: string): string {
  const name = alias.displayName || (alias.isDefault ? fallbackName : undefined);
  return name ? `${name} <${alias.email}>` : alias.email;
}

/** Extract the email portion of a bare or formatted address. */
function extractBareEmail(address: string): string {
  const match = address.match(/<([^>]+)>$/);
  return match ? match[1] : address;
}

/**
 * Remove an address from a recipient list using case-insensitive email matching.
 * Returns the original array when there is no match so React state is not updated
 * unnecessarily.
 */
export function excludeEmailAddress(addresses: string[], excludedAddress: string): string[] {
  const excludedEmail = extractBareEmail(excludedAddress).toLowerCase();
  const filtered = addresses.filter(
    (address) => extractBareEmail(address).toLowerCase() !== excludedEmail,
  );
  return filtered.length === addresses.length ? addresses : filtered;
}
