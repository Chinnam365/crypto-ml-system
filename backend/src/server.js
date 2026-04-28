const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= CONFIG =================
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
const INTERVAL = "1m";

let model = {
  w1: 0.5,
  w2: 0.5,
  w3: 0.5,
  w4: 0.5,
  w5: 0.5,
};

const TAKE_PROFIT = 0.01;
const STOP_LOSS = -0.005;

// ================= INIT DB =================
async function initDB() {
  console.log("Initializing DB...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS candles (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      open FLOAT,
      high FLOAT,
      low FLOAT,
      close FLOAT,
      volume FLOAT,
      timestamp BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      close FLOAT,
      macd FLOAT,
      macd_signal FLOAT,
      macd_hist FLOAT,
      volume FLOAT,
      momentum FLOAT,
      timestamp BIGINT
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
    INSERT INTO model (w1,w2,w3,w4,w5)
    SELECT 0.5,0.5,0.5,0.5,0.5
    WHERE NOT EXISTS (SELECT 1 FROM model);
  `);
}

// ================= FETCH =================
async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=50`;
  const res = await axios.get(url);
  return res.data;
}

// ================= FEATURES =================
function computeFeatures(candles) {
  const closes = candles.map(c => parseFloat(c[4]));
  const volumes = candles.map(c => parseFloat(c[5]));

  const i = closes.length - 1;

  return {
    close: closes[i],
    macd: closes[i] - closes[i - 10],
    macd_signal: closes[i - 1] - closes[i - 11],
    macd_hist: (closes[i] - closes[i - 10]) - (closes[i - 1] - closes[i - 11]),
    volume: volumes.reduce((a, b) => a + b, 0) / volumes.length,
    momentum: closes[i] - closes[i - 5],
  };
}

// ================= STORE =================
async function store(symbol, candles, f) {
  try {
    const c = candles[candles.length - 1];

    await pool.query(
      `INSERT INTO candles (symbol, open, high, low, close, volume, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [symbol, c[1], c[2], c[3], c[4], c[5], c[0]]
    );

    await pool.query(
      `INSERT INTO features (symbol, close, macd, macd_signal, macd_hist, volume, momentum, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [symbol, f.close, f.macd, f.macd_signal, f.macd_hist, f.volume, f.momentum, c[0]]
    );

  } catch (e) {
    console.log("Insert error:", e.message);
  }
}

// ================= CLEANUP =================
async function cleanupDB() {
  console.log("Cleaning DB...");

  await pool.query(`
    DELETE FROM candles
    WHERE id NOT IN (
      SELECT id FROM candles ORDER BY timestamp DESC LIMIT 5000
    );
  `);

  await pool.query(`
    DELETE FROM features
    WHERE id NOT IN (
      SELECT id FROM features ORDER BY timestamp DESC LIMIT 5000
    );
  `);
}

// ================= TRAIN =================
async function trainModel() {
  const res = await pool.query(`
    SELECT * FROM features ORDER BY timestamp DESC LIMIT 300
  `);

  const data = res.rows;
  if (data.length < 50) return;

  for (let i = 0; i < data.length - 5; i++) {
    const f = data[i];
    const future = data[i + 5];

    const change = (future.close - f.close) / f.close;

    const signal =
      model.w1 * f.macd +
      model.w2 * f.macd_hist +
      model.w3 * f.momentum +
      model.w4 * f.volume +
      model.w5;

    if (signal > 0 && change > TAKE_PROFIT) {
      model.w1 += 0.01;
      model.w2 += 0.01;
      model.w3 += 0.01;
    }

    if (signal > 0 && change < STOP_LOSS) {
      model.w1 -= 0.01;
      model.w2 -= 0.01;
      model.w3 -= 0.01;
    }
  }

  await pool.query(
    `UPDATE model SET w1=$1,w2=$2,w3=$3,w4=$4,w5=$5 WHERE id=1`,
    [model.w1, model.w2, model.w3, model.w4, model.w5]
  );

  console.log("Model updated");
}

// ================= ENGINE =================
let counter = 0;

async function runEngine() {
  for (let s of SYMBOLS) {
    const candles = await fetchCandles(s);
    const f = computeFeatures(candles);
    await store(s, candles, f);
  }

  counter++;

  if (counter % 5 === 0) await trainModel();
  if (counter % 10 === 0) await cleanupDB();

  console.log("Tick done");
}

// ================= ROUTES =================
app.get("/", (req, res) => res.send("ML Engine Running"));

app.get("/status", async (req, res) => {
  const c = await pool.query("SELECT COUNT(*) FROM candles");
  const f = await pool.query("SELECT COUNT(*) FROM features");

  res.json({
    candles: c.rows[0].count,
    features: f.rows[0].count,
    model
  });
});

app.get("/model", async (req, res) => {
  const r = await pool.query("SELECT * FROM model LIMIT 1");
  res.json(r.rows[0]);
});

app.get("/train", async (req, res) => {
  await trainModel();
  res.send("trained");
});

// ================= START =================
const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Running on", PORT);
  });

  setInterval(runEngine, 60000);
});
