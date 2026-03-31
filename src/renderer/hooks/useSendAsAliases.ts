import { useQuery } from "@tanstack/react-query";
import type { SendAsAlias, IpcResponse, Config } from "../../shared/types";

export function useSendAsAliases(accountId: string) {
  const { data: aliases = [], isLoading } = useQuery({
    queryKey: ["send-as-aliases", accountId],
    queryFn: async () => {
      const result = (await window.api.accounts.getSendAsAliases(accountId)) as IpcResponse<SendAsAlias[]>;
      return result.success && result.data ? result.data : [];
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — matches server-side cache TTL
  });

  // Read the per-account default alias from the shared config cache
  const { data: defaultAlias } = useQuery({
    queryKey: ["general-config"],
    queryFn: async () => {
      const result = (await window.api.settings.get()) as IpcResponse<Config>;
      return result.success ? result.data : null;
    },
    select: (config) => config?.defaultSendAs?.[accountId],
  });

  return { aliases, isLoading, defaultAlias };
}

/**
 * Walk thread emails (most recent first) and return the first alias email
 * found in the To or CC headers. Returns undefined if no match.
 */
export function detectAliasFromThread(
  aliases: SendAsAlias[],
  threadEmails: Array<{ to: string; cc?: string }>,
): string | undefined {
  if (aliases.length <= 1) return undefined;

  const aliasSet = new Set(aliases.map(a => a.email.toLowerCase()));

  // Walk in reverse (most recent email first)
  for (let i = threadEmails.length - 1; i >= 0; i--) {
    const email = threadEmails[i];
    for (const addr of parseAddresses(email.to)) {
      if (aliasSet.has(addr)) return addr;
    }
    if (email.cc) {
      for (const addr of parseAddresses(email.cc)) {
        if (aliasSet.has(addr)) return addr;
      }
    }
  }
  return undefined;
}

/** Extract lowercase bare emails from a comma-separated address header. */
function parseAddresses(header: string): string[] {
  return header
    .split(",")
    .map(s => {
      const match = s.match(/<([^>]+)>/);
      return (match ? match[1] : s.trim()).toLowerCase();
    })
    .filter(Boolean);
}
