// PROTOTYPE — throwaway Knock spike for "Does Knock hold up against Cadence?". Never merge.
import Knock, { signUserToken } from "@knocklabs/node";
import { alias } from "drizzle-orm/sqlite-core";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { db } from "~/db";
import { comments, lessons, users } from "~/db/schema";

let knock: Knock | undefined;

function getKnock() {
  if (!knock) {
    try {
      process.loadEnvFile();
    } catch {}
    knock = new Knock();
  }
  return knock;
}

export function getKnockPublicConfig() {
  getKnock();
  return {
    publicKey: process.env.KNOCK_PUBLIC_API_KEY!,
    feedChannelId: process.env.KNOCK_FEED_CHANNEL_ID!,
  };
}

function getUser(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function identify(id: number) {
  const user = getUser(id);
  if (!user) throw new Error(`No user ${id}`);
  await getKnock().users.update(String(id), {
    name: user.name,
    email: user.email,
  });
  return user;
}

export async function prepareFeedSession(userId: number) {
  const user = await identify(userId);
  const token = await signUserToken(String(userId), { expiresInSeconds: 3600 });
  const preferences = await getKnock().users.getPreferences(
    String(userId),
    "default"
  );
  return { user, token, preferences };
}

export async function signTokenFor(userId: number) {
  return signUserToken(String(userId), { expiresInSeconds: 300 });
}

export function listRealReplies() {
  const parent = alias(comments, "parent");
  const replier = alias(users, "replier");
  const author = alias(users, "author");
  return db
    .select({
      replyId: comments.id,
      body: comments.body,
      lessonTitle: lessons.title,
      replierId: replier.id,
      replierName: replier.name,
      authorId: author.id,
      authorName: author.name,
    })
    .from(comments)
    .innerJoin(parent, eq(parent.id, comments.parentId))
    .innerJoin(replier, eq(replier.id, comments.userId))
    .innerJoin(author, eq(author.id, parent.userId))
    .innerJoin(lessons, eq(lessons.id, comments.lessonId))
    .where(
      and(
        isNotNull(comments.parentId),
        isNull(comments.deletedAt),
        ne(comments.userId, parent.userId)
      )
    )
    .orderBy(desc(comments.createdAt))
    .all();
}

export async function triggerDiscussionReply(replyId: number) {
  const reply = listRealReplies().find((r) => r.replyId === replyId);
  if (!reply) throw new Error(`No reply ${replyId}`);
  await identify(reply.replierId);
  await identify(reply.authorId);
  const run = await getKnock().workflows.trigger("comment-reply-mention", {
    actor: String(reply.replierId),
    recipients: [String(reply.authorId)],
    data: {
      replier_name: reply.replierName,
      lesson_title: reply.lessonTitle,
      excerpt: reply.body.slice(0, 140),
      reply_id: reply.replyId,
    },
  });
  return { runId: run.workflow_run_id, recipient: reply.authorName };
}

export async function triggerNewEnrollment(instructorId: number) {
  const studentId = 5;
  await identify(instructorId);
  const student = await identify(studentId);
  const run = await getKnock().workflows.trigger("new-enrollment", {
    actor: String(studentId),
    recipients: [String(instructorId)],
    data: { student_name: student.name, course_title: "Prototype Course" },
  });
  return { runId: run.workflow_run_id };
}

export async function setNewEnrollmentPreference(
  userId: number,
  value: boolean | "reset"
) {
  const client = getKnock();
  if (value === "reset") {
    const current = await client.users.getPreferences(
      String(userId),
      "default"
    );
    const { ["new-enrollment"]: _, ...categories } = (current.categories ??
      {}) as Record<string, unknown>;
    return client.users.setPreferences(String(userId), "default", {
      ...current,
      categories: categories as never,
    });
  }
  return client.users.setPreferences(String(userId), "default", {
    __persistence_strategy__: "merge",
    categories: { "new-enrollment": value },
  } as never);
}
