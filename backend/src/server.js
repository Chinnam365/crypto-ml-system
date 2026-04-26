const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= CONFIG =================
const HOLD_TIME = 10;
const TAKE_PROFIT = 0.04;
const STOP_LOSS = -0.025;
const MIN_PROB = 0.52;
const LR = 0.08;

// ===== RISK =====
const MAX_RISK_PER_TRADE = 0.25;
const MAX_TOTAL_EXPOSURE = 0.9;
const MAX_DRAWDOWN = 0.2;

const SYMBOLS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","MATICUSDT"
];

// ================= INIT =================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id SERIAL PRIMARY KEY,
      cash FLOAT,
      total FLOAT,
      peak FLOAT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry FLOAT,
      amount FLOAT,
      cycles INT DEFAULT 0,
      f1 FLOAT,
      f2 FLOAT,
      f3 FLOAT,
      f4 FLOAT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      type TEXT,
      price FLOAT,
      pnl FLOAT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model (
      id SERIAL PRIMARY KEY,
      weights JSONB
    );
  `);

  const p = await pool.query(`SELECT * FROM portfolio`);
  if (p.rows.length === 0) {
    await pool.query(
      `INSERT INTO portfolio (cash,total,peak) VALUES (100,100,100)`
    );
  }

  const m = await pool.query(`SELECT * FROM model`);
  if (m.rows.length === 0) {
    await pool.query(
      `INSERT INTO model (weights) VALUES ($1)`,
      [JSON.stringify({ w1: 0.5, w2: 0.5, w3: 0.5, w4: 0.5 })]
    );
  }
}

// ================= SAFE API =================
async function getKlines(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=20`
    );
    return res.data;
  } catch (err) {
    console.error("API error:", symbol);
    return null;
  }
}

// ================= FEATURES =================
function extractFeatures(klines) {
  const closes = klines.map(k => parseFloat(k[4]));
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];

  const f1 = (last - prev) / prev;
  const f2 = (last - closes[0]) / closes[0];

  const max = Math.max(...closes);
  const min = Math.min(...closes);
  const f3 = (max - min) / min;

  const f4 = (last - max) / max;

  return { f1, f2, f3, f4, price: last };
}

// ================= MODEL =================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function predict(f, w) {
  const raw =
    f.f1 * w.w1 +
    f.f2 * w.w2 +
    f.f3 * w.w3 +
    f.f4 * w.w4;

  return Math.min(0.75, Math.max(0.25, sigmoid(raw)));
}

// ================= ENGINE =================
async function runEngine() {
  try {
    const modelRes = await pool.query(`SELECT * FROM model LIMIT 1`);
    let weights = modelRes.rows[0].weights;

    const pRes = await pool.query(`SELECT * FROM portfolio LIMIT 1`);
    let { cash, total, peak } = pRes.rows[0];

    const posRes = await pool.query(`SELECT * FROM positions`);
    let totalValue = cash;

    // ===== VALUE =====
    for (let pos of posRes.rows) {
      const klines = await getKlines(pos.symbol);
      if (!klines) continue;

      const price = parseFloat(klines[19][4]);
      if (!price || isNaN(price)) continue;

      totalValue += pos.amount * price;
    }

    // ===== DRAWDOWN =====
    peak = Math.max(peak, totalValue);
    const drawdown = (peak - totalValue) / peak;

    if (drawdown > MAX_DRAWDOWN) {
      console.log("⚠️ Drawdown stop triggered");
      await pool.query(
        `UPDATE portfolio SET total=$1, peak=$2`,
        [totalValue, peak]
      );
      return;
    }

    // ===== SELL =====
    for (let pos of posRes.rows) {
      const klines = await getKlines(pos.symbol);
      if (!klines) continue;

      const price = parseFloat(klines[19][4]);
      if (!price || isNaN(price)) continue;

      const pnl = (price - pos.entry) / pos.entry;
      let cycles = pos.cycles + 1;

      if (
        pnl >= TAKE_PROFIT ||
        pnl <= STOP_LOSS ||
        cycles >= HOLD_TIME ||
        (cycles > 5 && pnl > 0)
      ) {
        await pool.query(`DELETE FROM positions WHERE id=$1`, [pos.id]);

        await pool.query(
          `INSERT INTO trades (symbol,type,price,pnl)
           VALUES ($1,$2,$3,$4)`,
          [pos.symbol, "SELL", price, pnl]
        );

        cash += pos.amount * price;

        const predicted = predict(pos, weights);
        const actual = pnl > 0 ? 1 : 0;
        const error = actual - predicted;

        weights.w1 += LR * error * pos.f1;
        weights.w2 += LR * error * pos.f2;
        weights.w3 += LR * error * pos.f3;
        weights.w4 += LR * error * pos.f4;

      } else {
        await pool.query(
          `UPDATE positions SET cycles=$1 WHERE id=$2`,
          [cycles, pos.id]
        );
      }
    }

    // ===== BUY =====
    const existing = posRes.rows.map(p => p.symbol);
    const candidates = [];

    for (let symbol of SYMBOLS) {
      const klines = await getKlines(symbol);
      if (!klines) continue;

      const f = extractFeatures(klines);
      if (!f.price || isNaN(f.price)) continue;

      const prob = predict(f, weights);

      if (!existing.includes(symbol)) {
        if (prob > MIN_PROB || Math.random() < 0.2) {
          candidates.push({ symbol, prob, ...f });
        }
      }
    }

    const top = candidates.sort((a, b) => b.prob - a.prob).slice(0, 5);

    let invested = totalValue - cash;
    let exposure = invested / totalValue;

    if (cash > 1 && exposure < MAX_TOTAL_EXPOSURE && top.length > 0) {
      const weightsAlloc = top.map(c => Math.max(0, c.prob - MIN_PROB));
      const sum = weightsAlloc.reduce((a, b) => a + b, 0);

      for (let i = 0; i < top.length; i++) {
        const coin = top[i];

        let allocation =
          sum > 0 ? (weightsAlloc[i] / sum) * cash : cash / top.length;

        allocation = Math.min(allocation, totalValue * MAX_RISK_PER_TRADE);
        if (allocation < 1) continue;

        const amount = allocation / coin.price;

        await pool.query(
          `INSERT INTO positions (symbol,entry,amount,cycles,f1,f2,f3,f4)
           VALUES ($1,$2,$3,0,$4,$5,$6,$7)`,
          [coin.symbol, coin.price, amount, coin.f1, coin.f2, coin.f3, coin.f4]
        );

        await pool.query(
          `INSERT INTO trades (symbol,type,price,pnl)
           VALUES ($1,$2,$3,$4)`,
          [coin.symbol, "BUY", coin.price, 0]
        );

        cash -= allocation;
      }
    }

    // ===== ANTI-STUCK =====
    const remaining = await pool.query(`SELECT * FROM positions`);
    if (remaining.rows.length === 0 && cash > 1) {
      const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
      const klines = await getKlines(symbol);
      if (klines) {
        const f = extractFeatures(klines);
        const amount = cash / f.price;

        await pool.query(
          `INSERT INTO positions (symbol,entry,amount,cycles,f1,f2,f3,f4)
           VALUES ($1,$2,$3,0,$4,$5,$6,$7)`,
          [symbol, f.price, amount, f.f1, f.f2, f.f3, f.f4]
        );

        cash = 0;
      }
    }

    await pool.query(
      `UPDATE portfolio SET cash=$1,total=$2,peak=$3`,
      [cash, totalValue, peak]
    );

    await pool.query(
      `UPDATE model SET weights=$1`,
      [JSON.stringify(weights)]
    );

    console.log("✅ Engine tick success");

  } catch (err) {
    console.error("❌ Engine internal error:", err.message);
  }
}

// ================= ROUTES =================
app.get("/", async (req, res) => {
  const t = await pool.query(`SELECT * FROM trades WHERE type='SELL'`);
  const wins = t.rows.filter(r => r.pnl > 0).length;

  res.send(`
    <h1>🧠 ML Engine v12.1 (Stable)</h1>
    Trades: ${t.rows.length}<br/>
    Win Rate: ${t.rows.length ? ((wins/t.rows.length)*100).toFixed(2) : 0}%
    <br/><br/>
    <a href="/history">History</a>
    <br/><a href="/reset">Reset</a>
  `);
});

app.get("/history", async (req, res) => {
  const r = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 50`);
  res.send(r.rows.map(x => `<div>${x.type} ${x.symbol} ${(x.pnl*100).toFixed(2)}%</div>`).join(""));
});

app.get("/reset", async (req, res) => {
  await pool.query(`TRUNCATE positions, trades, model, portfolio RESTART IDENTITY`);
  res.send("Reset done");
});

// ================= START =================
const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();

  app.listen(PORT, () => {
    console.log("Running on", PORT);
  });

  setInterval(async () => {
    await runEngine();
  }, 60 * 1000);
}

start();
