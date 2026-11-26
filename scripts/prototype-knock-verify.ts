// PROTOTYPE — throwaway Knock spike verification. Never merge.
import Knock from "@knocklabs/node";

process.loadEnvFile();
const knock = new Knock();

for (const userId of (process.argv[2] ?? "1,2,3,4,5,6,7,9").split(",")) {
  const page = await knock.users.listMessages(userId, { page_size: 20 });
  console.log(
    `user ${userId} messages:`,
    page.items.map((m) => `${m.source.key} status=${m.status} read=${!!m.read_at} seen=${!!m.seen_at}`)
  );
  console.log(`  prefs:`, JSON.stringify((await knock.users.getPreferences(userId, "default")).categories));
}
