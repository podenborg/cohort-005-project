// PROTOTYPE — throwaway Knock spike for "Does Knock hold up against Cadence?". Never merge.
import { useCallback, useEffect, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/prototype.knock";
import { getCurrentUserId } from "~/lib/session";
import {
  getKnockPublicConfig,
  listRealReplies,
  prepareFeedSession,
  setNewEnrollmentPreference,
  signTokenFor,
  triggerDiscussionReply,
  triggerNewEnrollment,
} from "~/lib/prototype-knock.server";

export async function loader({ request }: Route.LoaderArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) return { session: null };
  const session = await prepareFeedSession(userId);
  return {
    session,
    config: getKnockPublicConfig(),
    replies: listRealReplies(),
    otherUserToken: { userId: userId === 1 ? 2 : 1, token: await signTokenFor(userId === 1 ? 2 : 1) },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const userId = await getCurrentUserId(request);
  if (!userId) throw new Response("Select a user from the DevUI panel", { status: 401 });
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "trigger-reply") {
      return { ok: true, result: await triggerDiscussionReply(Number(form.get("replyId"))) };
    }
    if (intent === "trigger-enrollment") {
      return { ok: true, result: await triggerNewEnrollment(userId) };
    }
    if (intent === "set-pref") {
      const raw = String(form.get("value"));
      const value = raw === "reset" ? "reset" : raw === "true";
      return { ok: true, result: await setNewEnrollmentPreference(userId, value) };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: false, error: `Unknown intent ${intent}` };
}

type FeedItem = {
  id: string;
  inserted_at: string;
  read_at: string | null;
  seen_at: string | null;
  source: { key: string; categories: string[] };
  blocks: { name: string; rendered: string }[];
  actors: { name?: string }[];
  data: Record<string, unknown>;
};

type FeedResponse = {
  entries: FeedItem[];
  meta: { total_count: number; unread_count: number; unseen_count: number };
};

function decodeJwtPart(token: string, part: 0 | 1) {
  return JSON.parse(atob(token.split(".")[part].replace(/-/g, "+").replace(/_/g, "/")));
}

export default function KnockPrototype({ loaderData }: Route.ComponentProps) {
  if (!loaderData.session) {
    return <div className="p-8">PROTOTYPE: select a user from the DevUI panel.</div>;
  }
  return <Spike key={loaderData.session.user.id} data={loaderData as SpikeData} />;
}

type SpikeData = Extract<Route.ComponentProps["loaderData"], { config: unknown }>;

function Spike({ data }: { data: SpikeData }) {
  const { session, config, replies, otherUserToken } = data;
  const userId = String(session.user.id);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [feedStatus, setFeedStatus] = useState<string>("loading");
  const [crossCheck, setCrossCheck] = useState<string | null>(null);
  const fetcher = useFetcher<typeof action>();

  const knockFetch = useCallback(
    (path: string, init?: RequestInit, token = session.token) =>
      fetch(`https://api.knock.app/v1${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${config.publicKey}`,
          "X-Knock-User-Token": token,
          "Content-Type": "application/json",
        },
      }),
    [config.publicKey, session.token]
  );

  const loadFeed = useCallback(async () => {
    const res = await knockFetch(`/users/${userId}/feeds/${config.feedChannelId}`);
    setFeedStatus(`${res.status} at ${new Date().toLocaleTimeString()}`);
    if (res.ok) setFeed(await res.json());
  }, [knockFetch, userId, config.feedChannelId]);

  useEffect(() => {
    setFeed(null);
    loadFeed();
    const id = setInterval(loadFeed, 4000);
    return () => clearInterval(id);
  }, [loadFeed]);

  async function mark(status: "read" | "seen" | "unread" | "unseen", ids: string[]) {
    const res = await knockFetch(`/messages/batch/${status}`, {
      method: "POST",
      body: JSON.stringify({ message_ids: ids }),
    });
    setFeedStatus(`mark ${status}: ${res.status}`);
    await loadFeed();
  }

  async function tryOtherUsersToken() {
    const res = await knockFetch(
      `/users/${userId}/feeds/${config.feedChannelId}`,
      undefined,
      otherUserToken.token
    );
    setCrossCheck(`User ${otherUserToken.userId}'s token on user ${userId}'s feed → ${res.status}`);
  }

  const claims = { ...decodeJwtPart(session.token, 0), ...decodeJwtPart(session.token, 1) };
  const enrollmentPref = (session.preferences.categories as Record<string, unknown> | null)?.[
    "new-enrollment"
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-8 text-sm">
      <div className="rounded border-2 border-dashed border-amber-500 bg-amber-50 p-3 font-semibold text-amber-900">
        PROTOTYPE — Knock spike. Throwaway; lives on the prototype/knock-spike branch only.
      </div>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-lg font-bold">1. Signed user token</h2>
        <p>
          Signed in as <b>{session.user.name}</b> (id {userId}, {session.user.role}). Switch users in
          the DevUI panel and the token and feed below follow.
        </p>
        <pre className="mt-2 overflow-auto bg-gray-100 p-2">
          {JSON.stringify(claims, null, 2)}
        </pre>
        <button className="mt-2 rounded bg-gray-800 px-3 py-1 text-white" onClick={tryOtherUsersToken}>
          Try reading this feed with user {otherUserToken.userId}'s token
        </button>
        {crossCheck && <p className="mt-1 font-mono">{crossCheck}</p>}
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-lg font-bold">2. Trigger a real Discussion Reply</h2>
        <p className="mb-2">Each row is a real reply in data.db. Triggering notifies the question author.</p>
        <ul className="space-y-1">
          {replies.map((r) => (
            <li key={r.replyId} className="flex items-center gap-2">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="trigger-reply" />
                <input type="hidden" name="replyId" value={r.replyId} />
                <button className="rounded bg-blue-600 px-2 py-0.5 text-white">Trigger</button>
              </fetcher.Form>
              <span>
                {r.replierName} replied to <b>{r.authorName}</b> (id {r.authorId}) on “{r.lessonTitle}”
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border p-4">
        <h2 className="mb-2 text-lg font-bold">4. Off-by-default, opt-in preference (new Enrollment)</h2>
        <p>
          This user's stored <code>new-enrollment</code> preference:{" "}
          <b>{enrollmentPref === undefined ? "not set (environment default applies)" : JSON.stringify(enrollmentPref)}</b>
        </p>
        <div className="mt-2 flex gap-2">
          {(["true", "false", "reset"] as const).map((v) => (
            <fetcher.Form method="post" key={v}>
              <input type="hidden" name="intent" value="set-pref" />
              <input type="hidden" name="value" value={v} />
              <button className="rounded border px-2 py-0.5">
                {v === "true" ? "Opt in" : v === "false" ? "Opt out" : "Reset to default"}
              </button>
            </fetcher.Form>
          ))}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="trigger-enrollment" />
            <button className="rounded bg-blue-600 px-2 py-0.5 text-white">
              Trigger new Enrollment to me
            </button>
          </fetcher.Form>
        </div>
        <pre className="mt-2 overflow-auto bg-gray-100 p-2">
          {JSON.stringify(session.preferences, null, 2)}
        </pre>
      </section>

      {fetcher.data && (
        <pre className={`overflow-auto p-2 ${fetcher.data.ok ? "bg-green-50" : "bg-red-50"}`}>
          Last action: {JSON.stringify(fetcher.data, null, 2)}
        </pre>
      )}

      <section className="rounded border p-4">
        <h2 className="mb-2 text-lg font-bold">3. Headless feed API (browser → Knock directly)</h2>
        <p className="font-mono">
          Last call: {feedStatus} · meta: {feed ? JSON.stringify(feed.meta) : "—"}
        </p>
        <button
          className="mt-2 rounded border px-2 py-0.5"
          disabled={!feed?.entries.length}
          onClick={() => feed && mark("seen", feed.entries.map((e) => e.id))}
        >
          Mark all visible seen
        </button>
        <ul className="mt-2 space-y-2">
          {feed?.entries.map((item) => (
            <li key={item.id} className={`rounded border p-2 ${item.read_at ? "opacity-60" : "bg-blue-50"}`}>
              <div
                className="prose prose-sm"
                dangerouslySetInnerHTML={{ __html: item.blocks[0]?.rendered ?? "(no blocks)" }}
              />
              <div className="mt-1 font-mono text-xs">
                {item.source.key} [{item.source.categories.join(", ")}] · seen {item.seen_at ? "✓" : "✗"} · read{" "}
                {item.read_at ? "✓" : "✗"}
              </div>
              <div className="mt-1 flex gap-2">
                <button className="rounded border px-2 text-xs" onClick={() => mark(item.read_at ? "unread" : "read", [item.id])}>
                  {item.read_at ? "Mark unread" : "Mark read"}
                </button>
                <button className="rounded border px-2 text-xs" onClick={() => mark(item.seen_at ? "unseen" : "seen", [item.id])}>
                  {item.seen_at ? "Mark unseen" : "Mark seen"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
