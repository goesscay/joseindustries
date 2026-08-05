import dotenv from "dotenv";
import { pool } from "../config/db";

dotenv.config();

const COMPANIES = [
  {
    code: "JE",
    name: "Jose Enterprises",
    tagline: "Dealers in Steel & Wooden Furnitures",
    address: "#47, Jayalakshmi Nagar, Madhanandapuram, Porur, Chennai - 600116",
    phone: "+91 8939269595, 044-65759595",
    email: null as string | null,
    gstin: "33AIWPJ1080F1ZA",
    state: "Tamil Nadu",
    state_code: "33",
    bank_name: "Karnataka Bank",
    bank_account_no: "1527000600191401",
    bank_ifsc: "KARB0000152",
  },
  {
    code: "JI",
    name: "Jose Industries",
    tagline: null as string | null,
    address: "Plot No 1D, Multi Industrial Estate, Gerugambakkam, Chennai - 600122",
    phone: "9884447442, 044-65759595, 044-24763476",
    email: null as string | null,
    gstin: "33AEBPC8427N1ZH",
    state: "Tamil Nadu",
    state_code: "33",
    bank_name: "Karnataka Bank",
    bank_account_no: "2767000600000601",
    bank_ifsc: "KARB0000276",
  },
];

async function seedCompanies() {
  for (const c of COMPANIES) {
    const [rows] = await pool.query<any[]>("SELECT id FROM companies WHERE code = ?", [c.code]);
    if (rows.length > 0) {
      console.log(`Company ${c.code} already exists, skipping.`);
      continue;
    }
    await pool.query(
      `INSERT INTO companies
         (code, name, tagline, address, phone, email, gstin, state, state_code, bank_name, bank_account_no, bank_ifsc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        c.code,
        c.name,
        c.tagline,
        c.address,
        c.phone,
        c.email,
        c.gstin,
        c.state,
        c.state_code,
        c.bank_name,
        c.bank_account_no,
        c.bank_ifsc,
      ]
    );
    console.log(`Created company ${c.code} - ${c.name}`);
  }
  await pool.end();
}

seedCompanies().catch((err) => {
  console.error("Seeding companies failed:", err);
  process.exit(1);
});
