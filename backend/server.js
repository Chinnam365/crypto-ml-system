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
 
// =========================
// DB INIT (SAFE + COMPLETE)
// =========================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candles (
      id SERIAL PRIMARY KEY,
      price FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      value FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model (
      id SERIAL PRIMARY KEY,
      w1 FLOAT,
      w2 FLOAT,
      w3 FLOAT,
      w4 FLOAT,
      w5 FLOAT
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

  // Insert default model if empty
  const res = await pool.query(`SELECT * FROM model LIMIT 1`);
  if (res.rows.length === 0) {
    await pool.query(`
      INSERT INTO model (w1, w2, w3, w4, w5)
      VALUES (0.5, 0.5, 0.5, 0.5, 0.5)
    `);
  }

  console.log("DB initialized");
}

// =========================
// ENGINE LOOP (SAFE)
// =========================
async function runEngine() {
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

    console.log(
      `Trade ${trades} | WinRate ${(wins / trades * 100).toFixed(2)}%`
    );

  } catch (err) {
    console.error("Engine error:", err.message);
  }
}

// Run every 5 sec
setInterval(runEngine, 5000);

// =========================
// ROUTES
// =========================

// HOME
app.get("/", (req, res) => {
  res.send(`
    <h1>🧠 ML Engine v13 (Clean)</h1>
    <p>Trades: ${trades}</p>
    <p>Win Rate: ${(trades ? (wins / trades * 100).toFixed(2) : 0)}%</p>
    <a href="/status">Status</a><br/>
    <a href="/model">Model</a><br/>
    <a href="/history">History</a>
  `);
});

// STATUS
app.get("/status", async (req, res) => {
  try {
    const count = await pool.query(`SELECT COUNT(*) FROM trades`);
    res.json({
      trades: count.rows[0].count,
      winRate: trades ? (wins / trades * 100).toFixed(2) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MODEL
app.get("/model", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM model ORDER BY id DESC LIMIT 1`
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HISTORY
app.get("/history", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM trades ORDER BY id DESC LIMIT 20`
  );
  res.json(result.rows);
});

// RESET
app.get("/reset", async (req, res) => {
  await pool.query(`DELETE FROM trades`);
  trades = 0;
  wins = 0;
  res.send("Reset complete");
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
