import { useCallback, useReducer, useRef, useState } from "react";

import { useNotify } from "./notify";
import { useSignIn } from "./sign-in";

import { type ViewerMarks, voteKey } from "~/lib/participation";
import { track } from "~/lib/pending-writes";
import { useViewer } from "~/lib/use-viewer";

type Vote = -1 | 0 | 1;
type TargetType = "post" | "comment";

/** One change the viewer made in this tab, and when. */
interface Change {
  vote?: Vote;
  score?: number;
  saved?: boolean;
  /** The viewer deleted it. */
  gone?: boolean;
  /** Milliseconds since the epoch. */
  at: number;
}

// The viewer's own changes in this tab, so a page restored by Back, whose
// data was loaded before them, still shows them. Never sent anywhere.
const changes = new Map<string, Change>();

function record(key: string, change: Omit<Change, "at">): void {
  changes.set(key, { ...changes.get(key), ...change, at: Date.now() });
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const response = await track(
      fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // Finishes even if the viewer reloads or leaves at once.
        keepalive: true,
      }),
    );
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

/**
 * Votes and saves on one page's posts and comments. Each change shows at once
 * and is undone if the server refuses it. Signed out, it opens sign-in
 * instead. `loadedAt` is when the page's data was loaded, in seconds.
 */
export function useParticipation(initial: ViewerMarks, loadedAt: number) {
  const viewer = useViewer();
  const signIn = useSignIn();
  const notify = useNotify();
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [marks, setMarks] = useState(initial);
  // Only the latest request for an item may settle it.
  const latest = useRef(new Map<string, number>());

  /** A change made in this tab after the page's data was loaded. */
  const later = (key: string): Change | undefined => {
    const change = changes.get(key);
    return change && change.at >= loadedAt * 1000 ? change : undefined;
  };

  /** Adds what a later page loaded, such as the next page of the feed. */
  const absorb = useCallback((more: ViewerMarks) => {
    setMarks((current) => ({
      votes: { ...current.votes, ...more.votes },
      saved: [...current.saved, ...more.saved],
      savedComments: [...current.savedComments, ...more.savedComments],
    }));
  }, []);

  const refuse = (status: number, data: Record<string, unknown>, fallback: string) => {
    if (status === 401) {
      signIn({ title: "Sign in to continue" });
      return;
    }
    notify(typeof data.message === "string" ? data.message : fallback);
  };

  const voteOf = (type: TargetType, id: string): Vote => {
    const key = voteKey(type, id);
    return later(key)?.vote ?? marks.votes[key] ?? 0;
  };

  const scoreOf = (type: TargetType, id: string, base: number): number =>
    later(voteKey(type, id))?.score ?? base;

  const vote = async (type: TargetType, id: string, base: number, next: Vote) => {
    if (!viewer) {
      signIn({ title: type === "post" ? "Sign in to vote on posts" : "Sign in to vote on comments" });
      return;
    }
    const key = voteKey(type, id);
    const previousVote = voteOf(type, id);
    const previousScore = scoreOf(type, id, base);
    const ticket = (latest.current.get(key) ?? 0) + 1;
    latest.current.set(key, ticket);

    record(key, { vote: next, score: previousScore - previousVote + next });
    refresh();

    const { ok, status, data } = await postJson("/api/vote", { type, id, value: next });
    if (latest.current.get(key) !== ticket) return;
    if (ok && typeof data.score === "number") {
      record(key, { vote: data.vote as Vote, score: data.score });
    } else {
      record(key, { vote: previousVote, score: previousScore });
      refuse(status, data, "Your vote did not go through. Try again.");
    }
    refresh();
  };

  const isSaved = (id: string, type: TargetType = "post"): boolean =>
    later(`save:${type}:${id}`)?.saved ?? (type === "post" ? marks.saved : marks.savedComments).includes(id);

  const toggleSave = async (id: string, type: TargetType = "post") => {
    if (!viewer) {
      signIn({ title: type === "post" ? "Sign in to save posts" : "Sign in to save comments" });
      return;
    }
    const key = `save:${type}:${id}`;
    const was = isSaved(id, type);
    const ticket = (latest.current.get(key) ?? 0) + 1;
    latest.current.set(key, ticket);

    record(key, { saved: !was });
    refresh();
    const { ok, status, data } = await postJson("/api/save", { type, id, saved: !was });
    if (latest.current.get(key) !== ticket || ok) return;
    record(key, { saved: was });
    refresh();
    refuse(status, data, "That did not save. Try again.");
  };

  /** A post the viewer deleted in this tab, which lists leave out. */
  const isGone = (id: string): boolean => changes.get(`post:${id}`)?.gone === true;
  const markGone = (id: string) => {
    record(`post:${id}`, { gone: true });
    refresh();
  };

  return { viewer, voteOf, scoreOf, vote, isSaved, toggleSave, absorb, isGone, markGone };
}
