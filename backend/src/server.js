const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= CONFIG =================
const SYMBOLS = ["BTCUSDT", "ETHUSDT"];
const INTERVAL = "1m";

let model = {
  w1: 0.5,
  w2: 0.5,
  w3: 0.5
};

// ================= INIT DB =================
async function initDB() {
  console.log("Initializing clean DB...");

  await pool.query(`
    CREATE TABLE candles (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      close FLOAT,
      timestamp BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE features (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      close FLOAT,
      momentum FLOAT,
      timestamp BIGINT
    );
  `);

  await pool.query(`
    CREATE TABLE model (
      id SERIAL PRIMARY KEY,
      w1 FLOAT,
      w2 FLOAT,
      w3 FLOAT
    );
  `);

  await pool.query(`
    INSERT INTO model (w1,w2,w3)
    VALUES (0.5,0.5,0.5);
  `);
}

// ================= FETCH =================
async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=20`;
  const res = await axios.get(url);
  return res.data;
}

// ================= FEATURES =================
function computeFeatures(candles) {
  const closes = candles.map(c => parseFloat(c[4]));
  const i = closes.length - 1;

  return {
    close: closes[i],
    momentum: closes[i] - closes[i - 3]
  };
}

// ================= STORE =================
async function store(symbol, candles, f) {
  const last = candles[candles.length - 1];

  await pool.query(
    `INSERT INTO candles (symbol, close, timestamp)
     VALUES ($1,$2,$3)`,
    [symbol, last[4], last[0]]
  );

  await pool.query(
    `INSERT INTO features (symbol, close, momentum, timestamp)
     VALUES ($1,$2,$3,$4)`,
    [symbol, f.close, f.momentum, last[0]]
  );
}

// ================= TRAIN =================
async function trainModel() {
  const res = await pool.query(`
    SELECT * FROM features ORDER BY timestamp DESC LIMIT 50
  `);

  const data = res.rows;
  if (data.length < 10) return;

  for (let i = 0; i < data.length - 3; i++) {
    const f = data[i];
    const future = data[i + 3];

    const change = (future.close - f.close) / f.close;

    if (change > 0.005) {
      model.w1 += 0.01;
    } else {
      model.w1 -= 0.01;
    }
  }

  await pool.query(
    `UPDATE model SET w1=$1,w2=$2,w3=$3 WHERE id=1`,
    [model.w1, model.w2, model.w3]
  );

  console.log("Model trained:", model);
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

  if (counter % 5 === 0) {
    await trainModel();
  }

  console.log("Tick done");
}

// ================= ROUTES =================
app.get("/", (req, res) => res.send("ML RESET SYSTEM RUNNING"));

app.get("/status", async (req, res) => {
  const c = await pool.query("SELECT COUNT(*) FROM candles");
  const f = await pool.query("SELECT COUNT(*) FROM features");

  res.json({
    candles: c.rows[0].count,
    features: f.rows[0].count,
    model
  });
});

// ================= START =================
const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Running on", PORT);
  });

  setInterval(runEngine, 60000);
});
