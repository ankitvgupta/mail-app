import type { DashboardEmail, IpcResponse } from "../../shared/types";
import { queryOptions } from "@tanstack/react-query";

/** Shared by selection prefetch and the detail view. React Query deduplicates
 * in-flight requests and releases unobserved bodies after a minute. */
export function threadQueryOptions(threadId: string, accountId: string) {
  return queryOptions({
    queryKey: ["email-thread", accountId, threadId],
    queryFn: async (): Promise<DashboardEmail[]> => {
      const response: IpcResponse<DashboardEmail[]> = await window.api.emails.getThread(
        threadId,
        accountId,
      );
      if (!response.success) throw new Error(response.error || "Unable to load conversation");
      return response.data;
    },
    staleTime: 15_000,
    gcTime: 60_000,
    retry: false,
  });
}
