const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

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

  // default weights
  await pool.query(`
    INSERT INTO model (w1,w2,w3,w4,w5)
    SELECT 0.5,0.5,0.5,0.5,0.5
    WHERE NOT EXISTS (SELECT 1 FROM model);
  `);
}

/* ================= FETCH DATA ================= */
async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=500`;

  const res = await axios.get(url);

  for (let c of res.data) {
    await pool.query(
      `INSERT INTO candles (symbol,time,open,high,low,close,volume)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [
        symbol,
        c[0],
        c[1],
        c[2],
        c[3],
        c[4],
        c[5]
      ]
    );
  }
}

/* ================= MACD ================= */
function calcEMA(values, period) {
  const k = 2 / (period + 1);
  let ema = values[0];
  return values.map(v => {
    ema = v * k + ema * (1 - k);
    return ema;
  });
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);

  const macd = ema12.map((v, i) => v - ema26[i]);
  const signal = calcEMA(macd, 9);
  const hist = macd.map((v, i) => v - signal[i]);

  return { macd, signal, hist };
}

/* ================= BUILD FEATURES ================= */
async function buildFeatures(symbol) {
  const res = await pool.query(
    `SELECT * FROM candles WHERE symbol=$1 ORDER BY time ASC`,
    [symbol]
  );

  const rows = res.rows;
  if (rows.length < 50) return;

  const closes = rows.map(r => r.close);
  const volumes = rows.map(r => r.volume);

  const { macd, signal, hist } = calcMACD(closes);

  for (let i = 30; i < rows.length; i++) {
    const momentum = closes[i] - closes[i - 5];
    const volatility = (rows[i].high - rows[i].low) / rows[i].close;

    await pool.query(
      `INSERT INTO features
       (symbol,time,close,volume,macd,macd_signal,macd_hist,momentum,volatility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
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

/* ================= TRAIN MODEL ================= */
async function trainModel() {
  const data = await pool.query(
    `SELECT * FROM features ORDER BY time DESC LIMIT 500`
  );

  if (data.rows.length < 50) return;

  let w = [0.5, 0.5, 0.5, 0.5, 0.5];
  let lr = 0.0001;

  for (let i = 1; i < data.rows.length; i++) {
    const f = data.rows[i];
    const prev = data.rows[i - 1];

    const target = (f.close - prev.close) > 0 ? 1 : 0;

    const x = [
      f.macd,
      f.macd_hist,
      f.momentum,
      f.volume,
      f.volatility
    ];

    const score = w.reduce((sum, wi, j) => sum + wi * x[j], 0);
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

/* ================= ENGINE LOOP ================= */
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

/* ================= SAFE LOOP ================= */
setInterval(runEngine, 60 * 1000); // every 1 min

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.send("ML Engine Running");
});

app.get("/status", async (req, res) => {
  const candles = await pool.query(`SELECT COUNT(*) FROM candles`);
  const features = await pool.query(`SELECT COUNT(*) FROM features`);
  res.json({
    candles: candles.rows[0].count,
    features: features.rows[0].count
  });
});

app.get("/model", async (req, res) => {
  const m = await pool.query(`SELECT * FROM model LIMIT 1`);
  res.json(m.rows[0] || {});
});

app.get("/train", async (req, res) => {
  try {
    await trainModel();
    res.send("Training done");
  } catch (e) {
    res.send("Training failed");
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 10000;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Server running on", PORT);
    });
  })
  .catch(err => {
    console.error("DB init failed:", err);
  });
