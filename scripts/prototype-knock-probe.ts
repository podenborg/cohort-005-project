// PROTOTYPE — throwaway Knock spike probe. Never merge.
import Knock, { signUserToken } from "@knocklabs/node";

process.loadEnvFile();

const knock = new Knock();
const userId = process.argv[2] ?? "1";

await knock.users.update(userId, { name: `Probe user ${userId}` });
const token = await signUserToken(userId, { expiresInSeconds: 300 });

const feed = await fetch(
  `https://api.knock.app/v1/users/${userId}/feeds/${process.env.KNOCK_FEED_CHANNEL_ID}`,
  {
    headers: {
      Authorization: `Bearer ${process.env.KNOCK_PUBLIC_API_KEY}`,
      "X-Knock-User-Token": token,
    },
  }
);
const body = await feed.json();
console.log("feed", feed.status, JSON.stringify(body.meta ?? body));

const otherToken = await signUserToken("2", { expiresInSeconds: 300 });
const cross = await fetch(
  `https://api.knock.app/v1/users/${userId}/feeds/${process.env.KNOCK_FEED_CHANNEL_ID}`,
  {
    headers: {
      Authorization: `Bearer ${process.env.KNOCK_PUBLIC_API_KEY}`,
      "X-Knock-User-Token": otherToken,
    },
  }
);
console.log("cross-user feed (user 2's token on user", userId, ")", cross.status, (await cross.text()).slice(0, 200));

for (const key of ["discussion-reply", "new-enrollment"]) {
  try {
    await knock.workflows.trigger(key, { recipients: ["probe-nobody"] });
    console.log("workflow", key, "exists");
  } catch (e) {
    console.log("workflow", key, "->", (e as Error).message.slice(0, 160));
  }
}
