const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const HOLD_TIME = 3;
const TAKE_PROFIT = 0.02;
const STOP_LOSS = -0.03;
const LR = 0.1; // learning rate

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
      f2 FLOAT
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
      [JSON.stringify({ w1: 0.5, w2: 0.5 })]
    );
  }
}

// ================= MARKET =================
async function getPrices() {
  const res = await axios.get("https://api.binance.com/api/v3/ticker/24hr");
  return res.data;
}

// ================= FEATURES =================
function extractFeatures(c) {
  const momentum = parseFloat(c.priceChangePercent) / 100;
  const crash = momentum < -0.05 ? Math.abs(momentum) : 0;

  return { f1: momentum, f2: crash };
}

// ================= MODEL =================
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function predict(f, w) {
  return sigmoid(f.f1 * w.w1 + f.f2 * w.w2);
}

// ================= ENGINE =================
async function runEngine() {
  const prices = await getPrices();

  const modelRes = await pool.query(`SELECT * FROM model LIMIT 1`);
  let weights = modelRes.rows[0].weights;

  const portfolio = await pool.query(`SELECT * FROM portfolio LIMIT 1`);
  let cash = portfolio.rows[0].cash;

  const positionsRes = await pool.query(`SELECT * FROM positions`);

  let totalValue = cash;

  // ===== SELL / HOLD =====
  for (let pos of positionsRes.rows) {
    const market = prices.find(p => p.symbol === pos.symbol);
    if (!market) continue;

    const price = parseFloat(market.lastPrice);
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

      // ===== REAL LEARNING =====
      const predicted = predict({ f1: pos.f1, f2: pos.f2 }, weights);
      const actual = pnl > 0 ? 1 : 0;
      const error = actual - predicted;

      weights.w1 += LR * error * pos.f1;
      weights.w2 += LR * error * pos.f2;

    } else {
      await pool.query(
        `UPDATE positions SET cycles=$1 WHERE id=$2`,
        [cycles, pos.id]
      );
    }
  }

  // ===== BUY =====
  const usdt = prices.filter(p => p.symbol.endsWith("USDT"));

  const scored = usdt.map(c => {
    const f = extractFeatures(c);
    const prob = predict(f, weights);
    return { symbol: c.symbol, prob, ...f };
  });

  const top5 = scored.sort((a, b) => b.prob - a.prob).slice(0, 5);

  if (cash > 1) {
    let invest = cash / top5.length;

    for (let coin of top5) {
      const market = prices.find(p => p.symbol === coin.symbol);
      const price = parseFloat(market.lastPrice);

      const amount = invest / price;

      await pool.query(
        `INSERT INTO positions (symbol,entry,amount,cycles,f1,f2)
         VALUES ($1,$2,$3,0,$4,$5)`,
        [coin.symbol, price, amount, coin.f1, coin.f2]
      );

      await pool.query(
        `INSERT INTO trades (symbol,type,price,pnl)
         VALUES ($1,$2,$3,$4)`,
        [coin.symbol, "BUY", price, 0]
      );
    }

    cash = 0;
  }

  await pool.query(
    `UPDATE portfolio SET cash=$1,total=$2`,
    [cash, totalValue]
  );

  await pool.query(
    `UPDATE model SET weights=$1`,
    [JSON.stringify(weights)]
  );

  return { top5, weights };
}

// ================= PERFORMANCE =================
async function getPerformance() {
  const t = await pool.query(`SELECT * FROM trades WHERE type='SELL'`);

  let wins = t.rows.filter(r => r.pnl > 0).length;
  let losses = t.rows.filter(r => r.pnl <= 0).length;

  let total = wins + losses;

  return {
    trades: total,
    winRate: total === 0 ? 0 : ((wins / total) * 100).toFixed(2)
  };
}

// ================= ROUTE =================
app.get("/", async (req, res) => {
  try {
    await initDB();

    const { top5, weights } = await runEngine();
    const perf = await getPerformance();

    res.send(`
      <h1>🧠 ML Engine v8 (Real Learning)</h1>

      <h3>📊 Performance</h3>
      Trades: ${perf.trades}<br/>
      Win Rate: ${perf.winRate}%

      <h3>🧠 Model</h3>
      w1: ${weights.w1.toFixed(2)}<br/>
      w2: ${weights.w2.toFixed(2)}

      <h3>🏆 Top 5</h3>
      ${top5.map(c => `<div>${c.symbol} (${(c.prob*100).toFixed(1)}%)</div>`).join("")}

      <br/><a href="/history">History</a>
      <br/><a href="/reset">Reset</a>
    `);
  } catch (e) {
    console.error(e);
    res.send("ERROR: " + e.message);
  }
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on", PORT));
