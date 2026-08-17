import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { users } from "../src/lib/db/schema";
import { copyApprovals, getUserByEmail } from "../src/lib/users";

/**
 * Names user 1 and, optionally, adds a second person who starts from the
 * first person's approved queue.
 *
 * The migration creates user 1 with a placeholder address because SQL can't
 * read the environment; this fills it in from REMINDER_TO_EMAIL.
 *
 *   npm run db:setup-users
 *   npm run db:setup-users -- --add "Mum" mum@example.com --copy-from 1
 *
 * Copying approvals rather than making someone swipe 137 dishes is the whole
 * point: family tastes overlap heavily, so inheriting a working queue and
 * correcting it later is far less work than starting from nothing. Only the
 * starting preferences are shared — history, pantry and model are separate
 * from the first reply onward, so the two diverge immediately.
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const ownerEmail = process.env.REMINDER_TO_EMAIL;
  const ownerName = arg("--owner-name") ?? "Owner";

  const owner = await db.query.users.findFirst({ where: eq(users.id, 1) });
  if (!owner) throw new Error("User 1 is missing. Run `npm run db:migrate` first.");

  if (ownerEmail && owner.email !== ownerEmail) {
    await db.update(users).set({ email: ownerEmail, name: ownerName }).where(eq(users.id, 1));
    console.log(`User 1 set to ${ownerName} <${ownerEmail}>`);
  } else {
    console.log(`User 1 is ${owner.name} <${owner.email}>`);
  }

  const addName = arg("--add");
  if (!addName) {
    const all = await db.select().from(users);
    console.log(`\n${all.length} user(s):`);
    for (const u of all) console.log(`  ${u.id}. ${u.name} <${u.email}> active=${u.isActive}`);
    process.exit(0);
  }

  const addEmail = process.argv[process.argv.indexOf("--add") + 2];
  if (!addEmail || !addEmail.includes("@")) {
    throw new Error('Usage: --add "Name" email@example.com [--copy-from 1]');
  }

  const existing = await getUserByEmail(addEmail);
  const target =
    existing ??
    (
      await db
        .insert(users)
        .values({ name: addName, email: addEmail.toLowerCase() })
        .returning()
    )[0];
  console.log(existing ? `${target.name} already exists as user ${target.id}` : `Added ${target.name} as user ${target.id}`);

  const copyFrom = arg("--copy-from");
  if (copyFrom) {
    const copied = await copyApprovals(Number(copyFrom), target.id);
    console.log(`Copied ${copied} approvals from user ${copyFrom} to ${target.name}.`);
    console.log("Their history, pantry and model stay their own — only the starting queue is shared.");
  }

  const all = await db.select().from(users);
  console.log(`\n${all.length} user(s):`);
  for (const u of all) console.log(`  ${u.id}. ${u.name} <${u.email}> active=${u.isActive}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
