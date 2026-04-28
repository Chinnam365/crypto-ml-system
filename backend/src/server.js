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
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"];
const INTERVAL = "1m";

// Entry-only model weights
let model = {
  w1: 0.5,
  w2: 0.5,
  w3: 0.5,
  w4: 0.5,
  w5: 0.5,
};

// Fixed exit strategy
const TAKE_PROFIT = 0.01;   // +1%
const STOP_LOSS = -0.005;   // -0.5%

// ================= INIT DB =================
async function initDB() {
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

  // Insert default model if empty
  await pool.query(`
    INSERT INTO model (w1,w2,w3,w4,w5)
    SELECT 0.5,0.5,0.5,0.5,0.5
    WHERE NOT EXISTS (SELECT 1 FROM model);
  `);
}

// ================= FETCH DATA =================
async function fetchCandles(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=50`;
  const res = await axios.get(url);
  return res.data;
}

// ================= FEATURE ENGINEERING =================
function computeFeatures(candles) {
  const closes = candles.map(c => parseFloat(c[4]));
  const volumes = candles.map(c => parseFloat(c[5]));

  const latest = closes.length - 1;

  const momentum = closes[latest] - closes[latest - 5];

  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  // Simplified MACD
  const macd = closes[latest] - closes[latest - 10];
  const macd_signal = closes[latest - 1] - closes[latest - 11];
  const macd_hist = macd - macd_signal;

  return {
    close: closes[latest],
    macd,
    macd_signal,
    macd_hist,
    volume: avgVolume,
    momentum,
  };
}

// ================= STORE =================
async function storeData(symbol, candles, features) {
  try {
    const last = candles[candles.length - 1];

    await pool.query(
      `INSERT INTO candles (symbol, open, high, low, close, volume, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        symbol,
        last[1],
        last[2],
        last[3],
        last[4],
        last[5],
        last[0],
      ]
    );

    await pool.query(
      `INSERT INTO features (symbol, close, macd, macd_signal, macd_hist, volume, momentum, timestamp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        symbol,
        features.close,
        features.macd,
        features.macd_signal,
        features.macd_hist,
        features.volume,
        features.momentum,
        last[0],
      ]
    );
  } catch (err) {
    console.log("Insert error (ignored):", err.message);
  }
}

// ================= CLEANUP (CRITICAL) =================
async function cleanupDB() {
  console.log("Running DB cleanup...");

  await pool.query(`
    DELETE FROM candles
    WHERE id NOT IN (
      SELECT id FROM candles ORDER BY timestamp DESC LIMIT 10000
    );
  `);

  await pool.query(`
    DELETE FROM features
    WHERE id NOT IN (
      SELECT id FROM features ORDER BY timestamp DESC LIMIT 10000
    );
  `);
}

// ================= ML TRAINING =================
async function trainModel() {
  const res = await pool.query(`
    SELECT * FROM features
    ORDER BY timestamp DESC
    LIMIT 500
  `);

  const data = res.rows;
  if (data.length < 50) return;

  let updates = { w1: 0, w2: 0, w3: 0, w4: 0, w5: 0 };

  for (let i = 0; i < data.length - 10; i++) {
    const f = data[i];
    const future = data[i + 5];

    const priceChange = (future.close - f.close) / f.close;

    const signal =
      model.w1 * f.macd +
      model.w2 * f.macd_hist +
      model.w3 * f.momentum +
      model.w4 * f.volume +
      model.w5;

    const decision = signal > 0 ? 1 : -1;

    // reward system
    if (decision === 1 && priceChange > TAKE_PROFIT) {
      updates.w1 += 0.01;
      updates.w2 += 0.01;
      updates.w3 += 0.01;
    } else if (decision === 1 && priceChange < STOP_LOSS) {
      updates.w1 -= 0.01;
      updates.w2 -= 0.01;
      updates.w3 -= 0.01;
    }
  }

  // Apply updates
  model.w1 += updates.w1;
  model.w2 += updates.w2;
  model.w3 += updates.w3;

  // Save model
  await pool.query(
    `UPDATE model SET w1=$1,w2=$2,w3=$3,w4=$4,w5=$5 WHERE id=1`,
    [model.w1, model.w2, model.w3, model.w4, model.w5]
  );

  console.log("Model trained:", model);
}

// ================= ENGINE LOOP =================
let counter = 0;

async function runEngine() {
  for (let symbol of SYMBOLS) {
    const candles = await fetchCandles(symbol);
    const features = computeFeatures(candles);

    await storeData(symbol, candles, features);
  }

  counter++;

  if (counter % 5 === 0) {
    await trainModel();
  }

  if (counter % 10 === 0) {
    await cleanupDB();
  }

  console.log("Engine tick complete");
}

// ================= ROUTES =================
app.get("/", (req, res) => {
  res.send("ML Engine Running");
});

app.get("/model", async (req, res) => {
  const result = await pool.query(`SELECT * FROM model LIMIT 1`);
  res.json(result.rows[0]);
});

app.get("/train", async (req, res) => {
  await trainModel();
  res.send("Training completed");
});

app.get("/status", async (req, res) => {
  const candles = await pool.query(`SELECT COUNT(*) FROM candles`);
  const features = await pool.query(`SELECT COUNT(*) FROM features`);

  res.json({
    candles: candles.rows[0].count,
    features: features.rows[0].count,
    model,
  });
});

// ================= START =================
const PORT = process.env.PORT || 10000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log("Server running on port", PORT);
  });

  setInterval(runEngine, 60000); // every 1 min
});
