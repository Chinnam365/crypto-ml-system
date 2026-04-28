const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
 
const PORT = process.env.PORT || 10000;

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let model = { w1: 0.5, w2: 0.5 };

// ================= INIT DB =================
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS candles (
        id SERIAL PRIMARY KEY,
        symbol TEXT,
        close FLOAT,
        timestamp BIGINT
      );

      CREATE TABLE IF NOT EXISTS features (
        id SERIAL PRIMARY KEY,
        symbol TEXT,
        close FLOAT,
        momentum FLOAT
      );

      CREATE TABLE IF NOT EXISTS model (
        id SERIAL PRIMARY KEY,
        w1 FLOAT,
        w2 FLOAT
      );

      CREATE TABLE IF NOT EXISTS trades (
        id SERIAL PRIMARY KEY,
        symbol TEXT,
        entry_price FLOAT,
        exit_price FLOAT,
        result FLOAT,
        timestamp BIGINT
      );
    `);

    const res = await pool.query(`SELECT * FROM model LIMIT 1`);
    if (res.rows.length === 0) {
      await pool.query(`INSERT INTO model (w1,w2) VALUES (0.5,0.5)`);
    } else {
      model = res.rows[0];
    }

    console.log("DB initialized");
  } catch (err) {
    console.error("DB ERROR:", err.message);
  }
}

// ================= DATA =================
async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=20`;
  const res = await axios.get(url);

  return res.data.map(c => ({
    close: parseFloat(c[4]),
    time: c[0],
  }));
}

// ================= FEATURES =================
function computeFeatures(candles) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  return {
    close: last.close,
    momentum: last.close - prev.close,
  };
}

// ================= ML =================
function predict(f) {
  return model.w1 * f.momentum + model.w2 * f.close;
}

function shouldBuy(f) {
  return predict(f) > 0;
}

// ================= TRADES =================
async function createTrade(symbol, price) {
  await pool.query(
    `INSERT INTO trades (symbol, entry_price, timestamp)
     VALUES ($1,$2,$3)`,
    [symbol, price, Date.now()]
  );
}

async function evaluateTrades(priceMap) {
  const res = await pool.query(
    `SELECT * FROM trades WHERE exit_price IS NULL`
  );

  for (let t of res.rows) {
    const current = priceMap[t.symbol];
    if (!current) continue;

    const change = (current - t.entry_price) / t.entry_price;

    if (change >= 0.01 || change <= -0.005) {
      await pool.query(
        `UPDATE trades
         SET exit_price=$1, result=$2
         WHERE id=$3`,
        [current, change, t.id]
      );

      // Learning
      if (change > 0) model.w1 += 0.01;
      else model.w1 -= 0.01;

      await pool.query(
        `UPDATE model SET w1=$1, w2=$2 WHERE id=1`,
        [model.w1, model.w2]
      );
    }
  }
}

// ================= ENGINE =================
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT"];

async function runEngine() {
  try {
    let priceMap = {};

    for (let symbol of symbols) {
      const candles = await fetchCandles(symbol);
      const f = computeFeatures(candles);

      priceMap[symbol] = f.close;

      if (shouldBuy(f)) {
        console.log("BUY:", symbol);
        await createTrade(symbol, f.close);
      }
    }

    await evaluateTrades(priceMap);

    console.log("Engine tick done");
  } catch (err) {
    console.error("ENGINE ERROR:", err.message);
  }
}

// ================= ROUTES =================

// Debug
app.get("/test", (req, res) => {
  res.send("OK");
});

// Home UI
app.get("/", async (req, res) => {
  try {
    const trades = await pool.query(`SELECT * FROM trades`);
    const wins = trades.rows.filter(t => t.result > 0).length;

    const winRate = trades.rows.length
      ? ((wins / trades.rows.length) * 100).toFixed(2)
      : 0;

    res.send(`
      <h1>ML Engine v12.1 (Stable)</h1>
      <p>Trades: ${trades.rows.length}</p>
      <p>Win Rate: ${winRate}%</p>
      <a href="/history">History</a><br/>
      <a href="/status">Status API</a><br/>
      <a href="/model">Model API</a>
    `);
  } catch (err) {
    res.send(err.message);
  }
});

// STATUS
app.get("/status", async (req, res) => {
  try {
    const trades = await pool.query(`SELECT * FROM trades`);
    const wins = trades.rows.filter(t => t.result > 0).length;

    const result = {
      trades: trades.rows.length,
      winRate: trades.rows.length
        ? (wins / trades.rows.length) * 100
        : 0,
    };

    console.log("STATUS HIT:", result);
    res.json(result);
  } catch (err) {
    console.error("STATUS ERROR:", err.message);
    res.json({ error: err.message });
  }
});

// MODEL
app.get("/model", async (req, res) => {
  try {
    const m = await pool.query(`SELECT * FROM model LIMIT 1`);

    console.log("MODEL HIT:", m.rows[0]);
    res.json(m.rows[0] || {});
  } catch (err) {
    console.error("MODEL ERROR:", err.message);
    res.json({ error: err.message });
  }
});

// HISTORY
app.get("/history", async (req, res) => {
  try {
    const t = await pool.query(
      `SELECT * FROM trades ORDER BY id DESC LIMIT 20`
    );

    res.send(
      t.rows
        .map(
          r =>
            `BUY ${r.symbol} ${((r.result || 0) * 100).toFixed(2)}%`
        )
        .join("<br>")
    );
  } catch (err) {
    res.send(err.message);
  }
});

// ================= START =================
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});

// Run async AFTER server starts (non-blocking)
(async () => {
  try {
    await initDB();
    console.log("DB ready");

    setInterval(runEngine, 15000);
  } catch (err) {
    console.error("Startup error:", err.message);
  }
})();
async function runEngine() {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 10000)
    );

    await Promise.race([
      (async () => {
        let priceMap = {};

        for (let symbol of symbols) {
          const candles = await fetchCandles(symbol);
          const f = computeFeatures(candles);

          priceMap[symbol] = f.close;

          if (shouldBuy(f)) {
            await createTrade(symbol, f.close);
          }
        }

        await evaluateTrades(priceMap);
      })(),
      timeout,
    ]);

    console.log("Engine tick done");
  } catch (err) {
    console.error("ENGINE ERROR:", err.message);
  }
}
// START SERVER (REQUIRED FOR RENDER)
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
