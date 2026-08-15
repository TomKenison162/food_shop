import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { userSettings } from "./db/schema";
import { londonDateString } from "./date";

const SETTINGS_ID = 1;

export interface Settings {
  portions: 1 | 2;
  /** Inclusive YYYY-MM-DD through which reminders are paused, or null. */
  pausedUntil: string | null;
}

export async function getSettings(): Promise<Settings> {
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.id, SETTINGS_ID) });
  return {
    portions: (row?.portions === 1 ? 1 : 2) as 1 | 2,
    pausedUntil: row?.pausedUntil ?? null,
  };
}

export async function getPortionsSetting(): Promise<1 | 2> {
  return (await getSettings()).portions;
}

export async function isPaused(today = londonDateString()): Promise<boolean> {
  const { pausedUntil } = await getSettings();
  return pausedUntil !== null && pausedUntil >= today;
}

async function upsert(values: Partial<typeof userSettings.$inferInsert>): Promise<void> {
  const existing = await db.query.userSettings.findFirst({ where: eq(userSettings.id, SETTINGS_ID) });
  if (existing) {
    await db.update(userSettings).set(values).where(eq(userSettings.id, SETTINGS_ID));
  } else {
    await db.insert(userSettings).values({ id: SETTINGS_ID, ...values });
  }
}

export async function setPortionsSetting(portions: 1 | 2): Promise<void> {
  await upsert({ portions });
}

/** Pass null to resume immediately. */
export async function setPausedUntil(pausedUntil: string | null): Promise<void> {
  await upsert({ pausedUntil });
}
