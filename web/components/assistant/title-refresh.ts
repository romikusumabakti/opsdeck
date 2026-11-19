import type { QueryClient } from "@tanstack/react-query";
import {
  type ConversationList,
  getConversationQuery,
  listConversationsQuery,
} from "@/web/api/assistant";

/**
 * When to read the chat list again after a chat's first answer finished, in
 * ms after the previous read: the worker writes the generated title only
 * after the answer's stream has closed (one more model call, at most 30 s),
 * so the list is read a few times over ~35 s until that title shows.
 */
export const TITLE_REFRESH_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 20_000];

/** Chats being watched, so a second finished stream starts no second loop. */
const watching = new Set<string>();

function listedTitle(
  queryClient: QueryClient,
  conversationId: string
): string | undefined {
  const list = queryClient.getQueryData<ConversationList>(
    listConversationsQuery().queryKey
  );
  return [...(list?.pinned ?? []), ...(list?.recent ?? [])].find(
    (c) => c.id === conversationId
  )?.title;
}

/**
 * Reads the chat list (and that chat) again until the chat's title is no
 * longer `firstTitle` (the one taken from its first question) or the
 * delays run out. No-op while one is already running for that chat.
 */
export function refreshTitleAfterFirstAnswer(
  queryClient: QueryClient,
  conversationId: string,
  firstTitle: string
) {
  if (watching.has(conversationId)) return;
  watching.add(conversationId);
  let step = 0;
  const tick = async () => {
    await queryClient
      .invalidateQueries({ queryKey: listConversationsQuery().queryKey })
      .catch(() => {});
    const title = listedTitle(queryClient, conversationId);
    if (title !== undefined && title !== firstTitle) {
      watching.delete(conversationId);
      void queryClient.invalidateQueries({
        queryKey: getConversationQuery(conversationId).queryKey,
      });
      return;
    }
    const delay = TITLE_REFRESH_DELAYS_MS[step++];
    if (delay === undefined) {
      watching.delete(conversationId);
      return;
    }
    setTimeout(() => void tick(), delay);
  };
  setTimeout(() => void tick(), TITLE_REFRESH_DELAYS_MS[step++]);
}

/** Forgets the running watches (tests). */
export function resetTitleRefreshForTests() {
  watching.clear();
}
