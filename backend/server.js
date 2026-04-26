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
const HOLD_TIME = 20;
const TAKE_PROFIT = 0.04;
const STOP_LOSS = -0.025;
const MIN_PROB = 0.52;
const LR = 0.08;

// ================= SYMBOLS =================
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
      total FLOAT
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
    await pool.query(`INSERT INTO portfolio (cash,total) VALUES (100,100)`);
  }

  const m = await pool.query(`SELECT * FROM model`);
  if (m.rows.length === 0) {
    await pool.query(
      `INSERT INTO model (weights) VALUES ($1)`,
      [JSON.stringify({ w1: 0.5, w2: 0.5, w3: 0.5, w4: 0.5 })]
    );
  }
}

// ================= MARKET =================
async function getKlines(symbol) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=20`
  );
  return res.data;
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
  const modelRes = await pool.query(`SELECT * FROM model LIMIT 1`);
  let weights = modelRes.rows[0].weights;

  const portfolioRes = await pool.query(`SELECT * FROM portfolio LIMIT 1`);
  let cash = portfolioRes.rows[0].cash;

  const positionsRes = await pool.query(`SELECT * FROM positions`);
  let totalValue = cash;

  // ===== SELL =====
  for (let pos of positionsRes.rows) {
    const klines = await getKlines(pos.symbol);
    const price = parseFloat(klines[19][4]);

    const pnl = (price - pos.entry) / pos.entry;
    totalValue += pos.amount * price;

    let cycles = pos.cycles + 1;

    if (pnl >= TAKE_PROFIT || pnl <= STOP_LOSS || cycles >= HOLD_TIME) {
      await pool.query(`DELETE FROM positions WHERE id=$1`, [pos.id]);

      await pool.query(
        `INSERT INTO trades (symbol,type,price,pnl)
         VALUES ($1,$2,$3,$4)`,
        [pos.symbol, "SELL", price, pnl]
      );

      cash += pos.amount * price;

      // learning
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
  const existing = positionsRes.rows.map(p => p.symbol);
  const candidates = [];

  for (let symbol of SYMBOLS) {
    const klines = await getKlines(symbol);
    const f = extractFeatures(klines);
    const prob = predict(f, weights);

    if (!existing.includes(symbol)) {
      if (prob > MIN_PROB || Math.random() < 0.2) {
        candidates.push({ symbol, prob, ...f });
      }
    }
  }

  const top = candidates
    .sort((a, b) => b.prob - a.prob)
    .slice(0, 5);

  // ===== POSITION SIZING =====
  if (cash > 1 && top.length > 0) {

    const weightsAlloc = top.map(c => Math.max(0, c.prob - MIN_PROB));
    const sum = weightsAlloc.reduce((a, b) => a + b, 0);

    for (let i = 0; i < top.length; i++) {
      const coin = top[i];

      const allocation =
        sum > 0 ? (weightsAlloc[i] / sum) * cash : cash / top.length;

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
    }

    cash = 0;
  }

  await pool.query(`UPDATE portfolio SET cash=$1,total=$2`, [cash, totalValue]);
  await pool.query(`UPDATE model SET weights=$1`, [JSON.stringify(weights)]);

  return { top, weights };
}

// ================= PERFORMANCE =================
async function getPerformance() {
  const t = await pool.query(`SELECT * FROM trades WHERE type='SELL'`);
  const wins = t.rows.filter(r => r.pnl > 0).length;
  const total = t.rows.length;

  return {
    trades: total,
    winRate: total === 0 ? 0 : ((wins / total) * 100).toFixed(2)
  };
}

// ================= ROUTES =================
app.get("/", async (req, res) => {
  await initDB();

  const { top, weights } = await runEngine();
  const perf = await getPerformance();

  res.send(`
    <h1>🧠 ML Engine v11.5 (Position Sizing)</h1>

    <h3>Performance</h3>
    Trades: ${perf.trades}<br/>
    Win Rate: ${perf.winRate}%

    <h3>Model</h3>
    w1: ${weights.w1.toFixed(2)}<br/>
    w2: ${weights.w2.toFixed(2)}<br/>
    w3: ${weights.w3.toFixed(2)}<br/>
    w4: ${weights.w4.toFixed(2)}

    <h3>Top Picks</h3>
    ${top.map(c => `<div>${c.symbol} (${(c.prob*100).toFixed(1)}%)</div>`).join("")}

    <br/><a href="/history">History</a>
    <br/><a href="/reset">Reset</a>
  `);
});

// HISTORY
app.get("/history", async (req, res) => {
  const result = await pool.query(`
    SELECT symbol, type, pnl, created_at 
    FROM trades ORDER BY created_at DESC LIMIT 50
  `);

  res.send(`
    <h1>Trade History</h1>
    ${result.rows.map(r => `
      <div>${r.type} ${r.symbol} | ${(r.pnl*100).toFixed(2)}%</div>
    `).join("")}
    <br/><a href="/">Back</a>
  `);
});

// RESET
app.get("/reset", async (req, res) => {
  await pool.query(`TRUNCATE positions, trades, model, portfolio RESTART IDENTITY`);
  res.send("Reset complete. <a href='/'>Restart</a>");
});

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on", PORT));
