import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { LOCAL_PGLITE_PATH } from "./src/lib/db/localPath";

export default process.env.DATABASE_URL
  ? defineConfig({
      schema: "./src/lib/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      dbCredentials: { url: process.env.DATABASE_URL },
      strict: true,
    })
  : defineConfig({
      schema: "./src/lib/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      driver: "pglite",
      dbCredentials: { url: LOCAL_PGLITE_PATH },
      strict: true,
    });
