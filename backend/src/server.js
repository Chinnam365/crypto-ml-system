const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= SAFE DB INIT =================
async function initDB() {
  try {
    // MODEL
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

    // INSERT DEFAULT MODEL IF EMPTY
    await pool.query(`
      INSERT INTO model (w1,w2,w3,w4,w5)
      SELECT 0.5,0.5,0.5,0.5,0.5
      WHERE NOT EXISTS (SELECT 1 FROM model);
    `);

    // TRADES
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        symbol TEXT,
        entry_price FLOAT,
        exit_price FLOAT,
        result FLOAT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ DB initialized");
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
    // GET MODEL
    const res = await pool.query(
      "SELECT * FROM model ORDER BY id DESC LIMIT 1"
    );
    const model = res.rows[0];

    if (!model) {
      console.log("No model yet");
      return;
    }

    // SIMULATED TRADE
    const entry = Math.random() * 100;
    const move = Math.random();

    let exit, result;

    if (move > 0.5) {
      exit = entry * 1.01; // +1%
      result = 1;
      stats.wins++;
    } else {
      exit = entry * 0.995; // -0.5%
      result = 0;
    }

    stats.trades++;

    // SAVE TRADE
    await pool.query(
      `INSERT INTO trades (symbol, entry_price, exit_price, result)
       VALUES ($1,$2,$3,$4)`,
      ["SIM", entry, exit, result]
    );

    console.log(`Trade #${stats.trades} | WinRate: ${(stats.wins / stats.trades * 100).toFixed(2)}%`);

    // CLEANUP (avoid Neon limit)
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
    <h1>🧠 ML Engine v12.2 (Stable)</h1>
    <p>Trades: ${stats.trades}</p>
    <p>Win Rate: ${winRate}%</p>
    <a href="/history">History</a><br/>
    <a href="/status">Status</a><br/>
    <a href="/model">Model</a>
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

  // START ENGINE AFTER SERVER IS LIVE
  setInterval(runEngine, 5000);
});
