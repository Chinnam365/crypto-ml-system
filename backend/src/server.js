const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const { buildFeatures } = require("./featureEngine");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const PORT = process.env.PORT || 10000;

// INIT DB
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candles (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      time BIGINT,
      open FLOAT,
      high FLOAT,
      low FLOAT,
      close FLOAT,
      volume FLOAT,
      UNIQUE(symbol, time)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      time BIGINT,

      macd FLOAT,
      macd_signal FLOAT,
      macd_hist FLOAT,

      momentum FLOAT,
      momentum_mid FLOAT,

      volume_spike FLOAT,
      obv FLOAT,

      volatility FLOAT,

      dist_low FLOAT,
      dist_high FLOAT,

      UNIQUE(symbol, time)
    );
  `);
}

// FETCH BINANCE DATA
async function fetchCandles(symbol) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines`,
    {
      params: {
        symbol,
        interval: "5m",
        limit: 1000
      }
    }
  );
  return res.data;
}

// SAVE CANDLES
async function saveCandles(symbol, data) {
  for (let k of data) {
    await pool.query(
      `INSERT INTO candles (symbol,time,open,high,low,close,volume)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (symbol,time) DO NOTHING`,
      [
        symbol,
        k[0],
        k[1],
        k[2],
        k[3],
        k[4],
        k[5]
      ]
    );
  }
}

// ROUTE: COLLECT DATA
app.get("/collect", async (req, res) => {
  const symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"];

  for (let s of symbols) {
    const data = await fetchCandles(s);
    await saveCandles(s, data);
  }

  res.send("Candles collected");
});

// ROUTE: BUILD FEATURES
app.get("/build-features", async (req, res) => {
  const symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"];

  for (let s of symbols) {
    await buildFeatures(s);
  }

  res.send("Features built successfully");
});
app.get("/debug-candles", async (req, res) => {
  const r = await pool.query(`SELECT symbol, COUNT(*) FROM candles GROUP BY symbol`);
  res.json(r.rows);
});
// ROUTE: COUNT FEATURES
app.get("/features-count", async (req, res) => {
  const r = await pool.query(`SELECT COUNT(*) FROM features`);
  res.send(`Total features: ${r.rows[0].count}`);
});
app.get("/candles-count", async (req, res) => {
  try {
    const r = await pool.query(`SELECT COUNT(*) FROM candles`);
    res.send(`Total candles: ${r.rows[0].count}`);
  } catch (err) {
    res.send("Error reading candles");
  }
});
// ROOT
app.get("/", (req, res) => {
  res.send("ML Engine Running");
});

// START SERVER
app.listen(PORT, async () => {
  await initDB();
  console.log(`Server running on ${PORT}`);
});
