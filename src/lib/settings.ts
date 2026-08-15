import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { userSettings } from "./db/schema";

const SETTINGS_ID = 1;

export async function getPortionsSetting(): Promise<1 | 2> {
  const row = await db.query.userSettings.findFirst({ where: eq(userSettings.id, SETTINGS_ID) });
  return (row?.portions === 1 ? 1 : 2) as 1 | 2;
}

export async function setPortionsSetting(portions: 1 | 2): Promise<void> {
  const existing = await db.query.userSettings.findFirst({ where: eq(userSettings.id, SETTINGS_ID) });
  if (existing) {
    await db.update(userSettings).set({ portions }).where(eq(userSettings.id, SETTINGS_ID));
  } else {
    await db.insert(userSettings).values({ id: SETTINGS_ID, portions });
  }
}
