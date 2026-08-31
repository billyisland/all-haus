import { request } from "./client";

export const externalItems = {
  like: (itemId: string, linkedAccountId: string) =>
    request<{ status: string }>(`/external-items/${itemId}/like`, {
      method: "POST",
      body: JSON.stringify({ linkedAccountId }),
    }),
  repost: (itemId: string, linkedAccountId: string) =>
    request<{ status: string }>(`/external-items/${itemId}/repost`, {
      method: "POST",
      body: JSON.stringify({ linkedAccountId }),
    }),
  reply: (itemId: string, linkedAccountId: string, content: string) =>
    request<{ noteId: string; nostrEventId: string }>(
      `/external-items/${itemId}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ linkedAccountId, content }),
      },
    ),
  pollVote: (itemId: string, linkedAccountId: string, choices: number[]) =>
    request<{ status: string }>(`/external-items/${itemId}/poll-vote`, {
      method: "POST",
      body: JSON.stringify({ linkedAccountId, choices }),
    }),
  extract: (url: string) =>
    request<{
      title: string;
      content: string;
      siteName: string;
      excerpt: string;
      byline: string;
      length: number;
    }>(`/extract?url=${encodeURIComponent(url)}`),
};
