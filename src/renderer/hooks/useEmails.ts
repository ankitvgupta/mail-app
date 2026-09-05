import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store";

export function useEmails() {
  const _queryClient = useQueryClient();
  const {
    setEmails,
    setLoading: _setLoading,
    setError: _setError,
    updateEmail,
  } = useAppStore.getState();
  const currentAccountId = useAppStore((state) => state.currentAccountId);

  const fetchEmailsQuery = useQuery({
    queryKey: ["emails", currentAccountId],
    queryFn: async () => {
      const result = await window.api.gmail.fetchUnread(100, currentAccountId ?? undefined);
      if (result.success) {
        setEmails(result.data);
        return result.data;
      }
      throw new Error(result.error);
    },
    enabled: false,
  });

  const analyzeMutation = useMutation({
    mutationFn: async (emailId: string) => {
      const result = await window.api.analysis.analyze(emailId);
      if (result.success) {
        return result.data;
      }
      throw new Error(result.error);
    },
    onSuccess: (data) => {
      updateEmail(data.id, data);
    },
  });

  const analyzeBatchMutation = useMutation({
    mutationFn: async (emailIds: string[]) => {
      const result = await window.api.analysis.analyzeBatch(emailIds);
      if (result.success) {
        return result.data;
      }
      throw new Error(result.error);
    },
    onSuccess: (data) => {
      setEmails(data);
    },
  });

  const createDraftMutation = useMutation({
    mutationFn: async ({
      emailId,
      body,
      accountId,
    }: {
      emailId: string;
      body: string;
      accountId?: string;
    }) => {
      const result = await window.api.gmail.createDraft(
        emailId,
        body,
        undefined,
        undefined,
        accountId,
      );
      if (result.success) {
        return { emailId, draftId: result.data.draftId };
      }
      throw new Error(result.error);
    },
    onSuccess: ({ emailId, draftId }) => {
      const email = useAppStore.getState().emails.find((e) => e.id === emailId);
      if (email?.draft) {
        updateEmail(emailId, {
          draft: {
            ...email.draft,
            gmailDraftId: draftId,
            status: "created",
          },
        });
      }
    },
  });

  return {
    fetchEmails: fetchEmailsQuery.refetch,
    isFetchingEmails: fetchEmailsQuery.isFetching,
    analyze: analyzeMutation.mutate,
    isAnalyzing: analyzeMutation.isPending,
    analyzeBatch: analyzeBatchMutation.mutate,
    isAnalyzingBatch: analyzeBatchMutation.isPending,
    createDraft: createDraftMutation.mutate,
    isCreatingDraft: createDraftMutation.isPending,
  };
}
