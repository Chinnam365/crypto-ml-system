const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let trades = 0;
let wins = 0;
let dbReady = false;

// =========================
// INIT DB (STRICT + SAFE)
// =========================
async function initDB() {
  try {
    console.log("Initializing DB...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS model (
        id SERIAL PRIMARY KEY,
        w1 FLOAT DEFAULT 0.5,
        w2 FLOAT DEFAULT 0.5,
        w3 FLOAT DEFAULT 0.5,
        w4 FLOAT DEFAULT 0.5,
        w5 FLOAT DEFAULT 0.5
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        symbol TEXT,
        type TEXT,
        entry_price FLOAT,
        exit_price FLOAT,
        result FLOAT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Ensure columns exist (fixes your exact errors)
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS type TEXT`);
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_price FLOAT`);
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_price FLOAT`);
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS result FLOAT`);

    const modelCheck = await pool.query(`SELECT * FROM model LIMIT 1`);

    if (modelCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO model (w1,w2,w3,w4,w5)
        VALUES (0.5,0.5,0.5,0.5,0.5)
      `);
    }

    dbReady = true;
    console.log("DB READY ✅");

  } catch (err) {
    console.error("DB INIT FAILED ❌", err.message);
  }
}

// =========================
// ENGINE LOOP (SAFE)
// =========================
async function runEngine() {
  if (!dbReady) return; // CRITICAL FIX

  try {
    const entry = Math.random() * 100;
    const exit = entry + (Math.random() - 0.5) * 2;
    const result = exit > entry ? 1 : 0;

    trades++;
    if (result === 1) wins++;

    await pool.query(
      `INSERT INTO trades (symbol, type, entry_price, exit_price, result)
       VALUES ($1,$2,$3,$4,$5)`,
      ["SIM", "BUY", entry, exit, result]
    );

    console.log(`Trade ${trades} | WinRate ${(wins / trades * 100).toFixed(2)}%`);

  } catch (err) {
    console.error("Engine error:", err.message);
  }
}

// =========================
// ROUTES
// =========================

app.get("/", (req, res) => {
  res.send(`
    <h1>🧠 ML Engine v13 (Stable)</h1>
    <p>Trades: ${trades}</p>
    <p>Win Rate: ${trades ? (wins / trades * 100).toFixed(2) : 0}%</p>
    <a href="/status">Status</a><br/>
    <a href="/model">Model</a><br/>
    <a href="/history">History</a>
  `);
});

app.get("/status", async (req, res) => {
  if (!dbReady) return res.json({ status: "initializing" });

  const count = await pool.query(`SELECT COUNT(*) FROM trades`);
  res.json({
    trades: count.rows[0].count,
    winRate: trades ? (wins / trades * 100).toFixed(2) : 0
  });
});

app.get("/model", async (req, res) => {
  if (!dbReady) return res.json({ status: "initializing" });

  const result = await pool.query(
    `SELECT * FROM model ORDER BY id DESC LIMIT 1`
  );
  res.json(result.rows[0] || {});
});

app.get("/history", async (req, res) => {
  if (!dbReady) return res.json([]);

  const result = await pool.query(
    `SELECT * FROM trades ORDER BY id DESC LIMIT 20`
  );
  res.json(result.rows);
});

app.get("/reset", async (req, res) => {
  await pool.query(`DELETE FROM trades`);
  trades = 0;
  wins = 0;
  res.send("Reset done");
});

// =========================
// START SERVER (CORRECT)
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  await initDB();

  // START ENGINE ONLY AFTER DB READY
  setInterval(runEngine, 5000);
});
