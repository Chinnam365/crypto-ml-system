const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

/* ================= DB ================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ================= INIT DB ================= */
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
      volume FLOAT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      time BIGINT,
      close FLOAT,
      volume FLOAT,
      macd FLOAT,
      macd_signal FLOAT,
      macd_hist FLOAT,
      momentum FLOAT,
      volatility FLOAT
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

  // default model
  await pool.query(`
    INSERT INTO model (w1,w2,w3,w4,w5)
    SELECT 0.5,0.5,0.5,0.5,0.5
    WHERE NOT EXISTS (SELECT 1 FROM model);
  `);
}

/* ================= FETCH ================= */
async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=200`;
  const res = await axios.get(url);

  for (let c of res.data) {
    await pool.query(
      `INSERT INTO candles (symbol,time,open,high,low,close,volume)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [symbol, c[0], c[1], c[2], c[3], c[4], c[5]]
    );
  }
}

/* ================= INDICATORS ================= */
function ema(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  return values.map(v => {
    ema = v * k + ema * (1 - k);
    return ema;
  });
}

function macdCalc(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = ema(macd, 9);
  const hist = macd.map((v, i) => v - signal[i]);

  return { macd, signal, hist };
}

/* ================= FEATURES ================= */
async function buildFeatures(symbol) {
  const res = await pool.query(
    `SELECT * FROM candles WHERE symbol=$1 ORDER BY time ASC`,
    [symbol]
  );

  const rows = res.rows;
  if (rows.length < 50) return;

  const closes = rows.map(r => r.close);
  const volumes = rows.map(r => r.volume);

  const { macd, signal, hist } = macdCalc(closes);

  for (let i = 30; i < rows.length; i++) {
    const momentum = closes[i] - closes[i - 5];
    const volatility = (rows[i].high - rows[i].low) / rows[i].close;

    await pool.query(
      `INSERT INTO features
       (symbol,time,close,volume,macd,macd_signal,macd_hist,momentum,volatility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        symbol,
        rows[i].time,
        closes[i],
        volumes[i],
        macd[i],
        signal[i],
        hist[i],
        momentum,
        volatility
      ]
    );
  }
}

/* ================= TRAIN ================= */
async function trainModel() {
  const res = await pool.query(
    `SELECT * FROM features ORDER BY time DESC LIMIT 500`
  );

  if (res.rows.length < 50) return;

  let w = [0.5, 0.5, 0.5, 0.5, 0.5];
  let lr = 0.0001;

  for (let i = 1; i < res.rows.length; i++) {
    const f = res.rows[i];
    const prev = res.rows[i - 1];

    const target = f.close > prev.close ? 1 : 0;

    const x = [
      f.macd,
      f.macd_hist,
      f.momentum,
      f.volume,
      f.volatility
    ];

    const score = w.reduce((s, wi, j) => s + wi * x[j], 0);
    const pred = score > 0 ? 1 : 0;
    const error = target - pred;

    for (let j = 0; j < w.length; j++) {
      w[j] += lr * error * x[j];
    }
  }

  await pool.query(`DELETE FROM model`);
  await pool.query(
    `INSERT INTO model (w1,w2,w3,w4,w5)
     VALUES ($1,$2,$3,$4,$5)`,
    w
  );

  console.log("Model trained:", w);
}

/* ================= ENGINE ================= */
const symbols = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT"];

async function runEngine() {
  try {
    for (let s of symbols) {
      await fetchCandles(s);
      await buildFeatures(s);
    }

    await trainModel();

    console.log("Engine tick complete");
  } catch (e) {
    console.error("Engine error:", e.message);
  }
}

setInterval(runEngine, 60000);

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.send("ML Engine Running");
});

app.get("/status", async (req, res) => {
  const c = await pool.query(`SELECT COUNT(*) FROM candles`);
  const f = await pool.query(`SELECT COUNT(*) FROM features`);

  res.json({
    candles: c.rows[0].count,
    features: f.rows[0].count
  });
});

/* ✅ FIXED MODEL ROUTE */
app.get("/model", async (req, res) => {
  const m = await pool.query(`
    SELECT * FROM model ORDER BY id DESC LIMIT 1
  `);
  res.json(m.rows[0] || {});
});

app.get("/train", async (req, res) => {
  await trainModel();
  res.send("Training done");
});

/* ================= START ================= */
const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server running on", PORT);
  });
});

