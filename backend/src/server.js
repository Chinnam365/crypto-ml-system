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

    console.log("DB ready");
  } catch (err) {
    console.error("DB INIT ERROR:", err.message);
  }
}

// ================= FETCH =================
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

// ================= TRADING =================
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

      // learning
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

    console.log("Engine tick");
  } catch (err) {
    console.error("ENGINE ERROR:", err.message);
  }
}

// ================= ROUTES =================

// DEBUG (VERY IMPORTANT)
app.get("/test", (req, res) => {
  res.send("SERVER WORKING ✅");
});

app.get("/", (req, res) => {
  res.send("ML Engine Running");
});

app.get("/status", async (req, res) => {
  try {
    const trades = await pool.query(`SELECT * FROM trades`);
    const wins = trades.rows.filter(t => t.result > 0).length;

    res.json({
      trades: trades.rows.length,
      winRate: trades.rows.length
        ? (wins / trades.rows.length) * 100
        : 0,
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get("/model", async (req, res) => {
  try {
    const m = await pool.query(`SELECT * FROM model LIMIT 1`);
    res.json(m.rows[0] || {});
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get("/history", async (req, res) => {
  try {
    const t = await pool.query(
      `SELECT * FROM trades ORDER BY id DESC LIMIT 20`
    );
    res.json(t.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ================= START =================
app.listen(PORT, async () => {
  console.log("Running on port", PORT);

  await initDB();

  setInterval(runEngine, 15000);
});
