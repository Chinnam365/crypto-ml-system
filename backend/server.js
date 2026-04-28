const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= DB INIT (SAFE + MIGRATION) =================
async function initDB() {
  try {
    // ===== MODEL =====
    await pool.query(`
      CREATE TABLE IF NOT EXISTS model (
        id SERIAL PRIMARY KEY
      );
    `);
 
    await pool.query(`
      ALTER TABLE model
      ADD COLUMN IF NOT EXISTS w1 FLOAT DEFAULT 0.5,
      ADD COLUMN IF NOT EXISTS w2 FLOAT DEFAULT 0.5,
      ADD COLUMN IF NOT EXISTS w3 FLOAT DEFAULT 0.5,
      ADD COLUMN IF NOT EXISTS w4 FLOAT DEFAULT 0.5,
      ADD COLUMN IF NOT EXISTS w5 FLOAT DEFAULT 0.5;
    `);

    await pool.query(`
      INSERT INTO model (w1,w2,w3,w4,w5)
      SELECT 0.5,0.5,0.5,0.5,0.5
      WHERE NOT EXISTS (SELECT 1 FROM model);
    `);

    // ===== TRADES =====
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY
      );
    `);

    await pool.query(`
  ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS symbol TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT,
  ADD COLUMN IF NOT EXISTS entry_price FLOAT,
  ADD COLUMN IF NOT EXISTS exit_price FLOAT,
  ADD COLUMN IF NOT EXISTS result FLOAT,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
`);

    console.log("✅ DB schema ready");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
}

// ================= ENGINE =================
let stats = {
  trades: 0,
  wins: 0,
};

async function runEngine() {
  try {
    const res = await pool.query(
      "SELECT * FROM model ORDER BY id DESC LIMIT 1"
    );

    const model = res.rows[0];
    if (!model) return;

    // SIMULATION (your logic can be replaced later)
    const entry = Math.random() * 100;
    const win = Math.random() > 0.5;

    const exit = win ? entry * 1.01 : entry * 0.995;
    const result = win ? 1 : 0;

    stats.trades++;
    if (win) stats.wins++;

    await pool.query(
      `INSERT INTO trades (symbol, entry_price, exit_price, result)
       VALUES ($1,$2,$3,$4)`,
      ["SIM", entry, exit, result]
    );

    console.log(
      `Trade ${stats.trades} | WinRate ${(stats.wins / stats.trades * 100).toFixed(2)}%`
    );

    // CLEANUP to avoid Neon limit
    if (stats.trades % 50 === 0) {
      await pool.query(`
        DELETE FROM trades
        WHERE id NOT IN (
          SELECT id FROM trades ORDER BY id DESC LIMIT 200
        )
      `);
      console.log("🧹 Cleanup done");
    }
  } catch (err) {
    console.error("Engine error:", err.message);
  }
}

// ================= ROUTES =================

// HOME
app.get("/", (req, res) => {
  const winRate = stats.trades
    ? ((stats.wins / stats.trades) * 100).toFixed(2)
    : 0;

  res.send(`
    <h1>🧠 ML Engine v13 (Stable)</h1>
    <p>Trades: ${stats.trades}</p>
    <p>Win Rate: ${winRate}%</p>
    <a href="/status">Status</a><br/>
    <a href="/model">Model</a><br/>
    <a href="/history">History</a>
  `);
});

// STATUS
app.get("/status", (req, res) => {
  const winRate = stats.trades
    ? ((stats.wins / stats.trades) * 100).toFixed(2)
    : 0;

  res.json({
    trades: stats.trades,
    winRate,
  });
});

// MODEL
app.get("/model", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM model ORDER BY id DESC LIMIT 1"
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HISTORY
app.get("/history", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM trades ORDER BY id DESC LIMIT 20"
    );

    let html = "<h2>Trade History</h2>";
    result.rows.forEach((t) => {
      html += `<p>${t.symbol} | ${t.result ? "WIN" : "LOSS"}</p>`;
    });

    res.send(html);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);

  await initDB();

  console.log("✅ Startup complete");

  // Run engine every 5 sec (non-blocking)
  setInterval(runEngine, 5000);
});
