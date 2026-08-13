import { useEffect, useMemo, useRef, useState } from "react";
import type { IpcResponse, SendAsAlias } from "../../shared/types";
import { useAppStore } from "../store";
import { formatAlias } from "../utils/alias-formatting";

/** Extract bare email from a potentially formatted "Name <email>" address. */
function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>$/);
  return match ? match[1] : addr;
}

interface CrossAccountFromSelectorProps {
  /** The account the compose form is currently routed through. */
  accountId: string;
  /** Currently-selected From string (formatted "Name <email>" or bare email). */
  selected: string | undefined;
  /**
   * Called when the user picks a different alias. Receives the new account
   * (which may differ from the current one) plus the formatted From string.
   * The parent should re-route the compose form to the new account.
   */
  onChange: (accountId: string, formatted: string) => void;
}

type Option = {
  accountId: string;
  accountEmail: string;
  accountDisplayName: string | undefined;
  alias: SendAsAlias;
  formatted: string;
};

/**
 * From picker for new-message compose in unified ("All Inboxes") mode. Lists
 * every send-as alias from every connected account so the user can choose
 * which account (and which alias within it) to send from. Picking an alias
 * from a different account re-routes the compose to that account.
 *
 * Renders nothing when only one account is connected — the existing per-
 * account FromSelector covers that case.
 */
export function CrossAccountFromSelector({
  accountId,
  selected,
  onChange,
}: CrossAccountFromSelectorProps) {
  const accounts = useAppStore((s) => s.accounts);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Map of accountId → fetched aliases. Each account's aliases are fetched
  // once on mount; if an account has no send-as configured we fall back to a
  // synthetic alias built from the account's own email + display name so the
  // user can still pick it.
  const [aliasesByAccount, setAliasesByAccount] = useState<Map<string, SendAsAlias[]>>(new Map());

  useEffect(() => {
    if (typeof window.api.compose.getSendAsAliases !== "function") return;
    let cancelled = false;
    (async () => {
      const results = await Promise.all(
        accounts.map(async (acc): Promise<readonly [string, SendAsAlias[]]> => {
          try {
            const res = (await window.api.compose.getSendAsAliases(acc.id)) as IpcResponse<
              SendAsAlias[]
            >;
            return [acc.id, res.success ? (res.data ?? []) : []] as const;
          } catch {
            return [acc.id, [] as SendAsAlias[]] as const;
          }
        }),
      );
      if (cancelled) return;
      setAliasesByAccount(new Map(results));
    })();
    return () => {
      cancelled = true;
    };
    // Re-fetch only when the account set itself changes (id list), not when
    // mutable fields like isConnected toggle.
  }, [accounts]);

  const options: Option[] = useMemo(() => {
    const out: Option[] = [];
    for (const acc of accounts) {
      const fetched = aliasesByAccount.get(acc.id) ?? [];
      const aliases: SendAsAlias[] =
        fetched.length > 0
          ? fetched
          : // Synthetic fallback so users without configured send-as still see
            // their account as a picker option. Mark as default so formatAlias
            // uses the account's display name when present.
            [
              {
                email: acc.email,
                displayName: acc.displayName,
                isDefault: true,
              } satisfies SendAsAlias,
            ];
      for (const alias of aliases) {
        out.push({
          accountId: acc.id,
          accountEmail: acc.email,
          accountDisplayName: acc.displayName,
          alias,
          formatted: formatAlias(alias, acc.displayName),
        });
      }
    }
    return out;
  }, [accounts, aliasesByAccount]);

  // Outside-click close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Nothing to pick between with a single account — let the per-account
  // FromSelector handle alias-level switching for that one account.
  if (accounts.length < 2) return null;

  const selectedBare = selected ? extractEmail(selected).toLowerCase() : "";
  const currentOption =
    options.find(
      (o) => o.accountId === accountId && o.alias.email.toLowerCase() === selectedBare,
    ) ??
    options.find((o) => o.accountId === accountId && o.alias.isDefault) ??
    options.find((o) => o.accountId === accountId) ??
    options[0];
  const currentLabel = currentOption?.formatted ?? "";

  // Group options by account for a cleaner dropdown when there are many.
  const groupedOptions = useMemo(() => {
    const groups = new Map<string, Option[]>();
    for (const opt of options) {
      const arr = groups.get(opt.accountId) ?? [];
      arr.push(opt);
      groups.set(opt.accountId, arr);
    }
    return Array.from(groups.entries()).map(([aid, opts]) => ({
      accountId: aid,
      accountEmail: opts[0]?.accountEmail ?? aid,
      options: opts,
    }));
  }, [options]);

  return (
    <div
      ref={ref}
      className="relative flex items-center gap-2 py-1.5 border-b border-gray-200 dark:border-gray-700/50"
    >
      <label className="w-10 text-sm text-gray-500 dark:text-gray-400 flex-shrink-0">From</label>
      <div className="flex-1 flex flex-wrap items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="min-w-0 text-left text-sm text-gray-900 dark:text-gray-100 truncate cursor-pointer pl-1.5"
        >
          {currentLabel}
        </button>
      </div>
      {open && (
        <div className="absolute left-10 top-full mt-1 z-50 min-w-[280px] max-w-[400px] bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-1">
          {groupedOptions.map((group, gi) => (
            <div key={group.accountId}>
              {gi > 0 && <div className="my-1 border-t border-gray-200 dark:border-gray-700" />}
              <div className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">
                {group.accountEmail}
              </div>
              {group.options.map((opt) => {
                const isCurrent =
                  opt.accountId === currentOption?.accountId &&
                  opt.alias.email.toLowerCase() === currentOption.alias.email.toLowerCase();
                return (
                  <button
                    key={`${opt.accountId}::${opt.alias.email}`}
                    type="button"
                    onClick={() => {
                      onChange(opt.accountId, opt.formatted);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-sm truncate transition-colors ${
                      isCurrent
                        ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                        : "text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700/50"
                    }`}
                  >
                    {opt.formatted}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
