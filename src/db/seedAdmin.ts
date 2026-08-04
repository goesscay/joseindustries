import crypto from "crypto";
import dotenv from "dotenv";
import { pool } from "../config/db";
import { hashPassword } from "../utils/password";

dotenv.config();

async function seedAdmin() {
  const [rows] = await pool.query<any[]>(
    "SELECT COUNT(*) as count FROM users WHERE role = 'super_admin'"
  );
  if (rows[0].count > 0) {
    console.log("A super admin already exists. Skipping seed.");
    await pool.end();
    return;
  }

  const name = process.env.SEED_ADMIN_NAME || "Super Admin";
  const email = process.env.SEED_ADMIN_EMAIL || "admin@joseindustries.in";
  const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");

  const password_hash = await hashPassword(password);
  await pool.query(
    "INSERT INTO users (name, email, password_hash, role, status) VALUES (?, ?, ?, 'super_admin', 'active')",
    [name, email, password_hash]
  );

  console.log("Super admin created:");
  console.log(`  Email:    ${email}`);
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.log(`  Password: ${password}  (generated - save this, it will not be shown again)`);
  } else {
    console.log("  Password: (from SEED_ADMIN_PASSWORD)");
  }

  await pool.end();
}

seedAdmin().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
