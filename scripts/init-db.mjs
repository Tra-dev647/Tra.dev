import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

execSync("npx prisma db push --skip-generate", { stdio: "inherit" });

const prisma = new PrismaClient();
try {
  const admins = await prisma.admin.count();
  if (admins === 0) {
    console.log("Empty database: running seed...");
    execSync("npx tsx prisma/seed.ts", { stdio: "inherit" });
  } else {
    console.log("Database already seeded, skipping seed.");
  }
} finally {
  await prisma.$disconnect();
}
