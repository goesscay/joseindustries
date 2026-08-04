import { Router } from "express";
import { pool } from "../config/db";
import { comparePassword } from "../utils/password";
import { signToken } from "../utils/jwt";
import { requireAuth } from "../middleware/auth";
import { asyncHandler } from "../utils/asyncHandler";
import { User } from "../types";

export const authRouter = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

function toPublicUser(user: User) {
  const { password_hash, ...publicUser } = user;
  return publicUser;
}

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) {
    return res.status(400).json({ message: "Email and password are required" });
  }

  const [rows] = await pool.query<any[]>("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
  const user = rows[0] as User | undefined;

  if (!user || user.status !== "active") {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const isValid = await comparePassword(password, user.password_hash);
  if (!isValid) {
    return res.status(401).json({ message: "Invalid credentials" });
  }

  const token = signToken({ sub: user.id, role: user.role });
  res.cookie("token", token, COOKIE_OPTIONS);
  res.json({ user: toPublicUser(user) });
}));

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("token", { ...COOKIE_OPTIONS, maxAge: undefined });
  res.json({ message: "Logged out" });
});

authRouter.get("/me", requireAuth, asyncHandler(async (req, res) => {
  const [rows] = await pool.query<any[]>("SELECT * FROM users WHERE id = ? LIMIT 1", [req.user!.sub]);
  const user = rows[0] as User | undefined;

  if (!user || user.status !== "active") {
    return res.status(401).json({ message: "Not authenticated" });
  }

  res.json({ user: toPublicUser(user) });
}));
