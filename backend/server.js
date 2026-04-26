const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

// ================= DB =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= INIT DB =================
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
      amount FLOAT
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

  // init portfolio if empty
  const p = await pool.query(`SELECT * FROM portfolio`);
  if (p.rows.length === 0) {
    await pool.query(
      `INSERT INTO portfolio (cash, total) VALUES ($1,$2)`,
      [100, 100]
    );
  }

  // init model
  const m = await pool.query(`SELECT * FROM model`);
  if (m.rows.length === 0) {
    await pool.query(
      `INSERT INTO model (weights) VALUES ($1)`,
      [JSON.stringify({ momentum: 1, crash: 1 })]
    );
  }
}

// ================= MARKET =================
async function getPrices() {
  const res = await axios.get(
    "https://api.binance.com/api/v3/ticker/24hr"
  );
  return res.data;
}

// ================= STRATEGY =================
function scoreCoin(c) {
  const change = parseFloat(c.priceChangePercent);
  const volume = parseFloat(c.quoteVolume);

  let momentum = change;
  let crash = change < -5 ? Math.abs(change) * 2 : 0;

  return {
    symbol: c.symbol,
    score: momentum + crash,
    change
  };
}

// ================= MAIN ENGINE =================
async function runEngine() {
  const prices = await getPrices();

  const usdt = prices.filter(p => p.symbol.endsWith("USDT"));

  const scored = usdt.map(scoreCoin);

  const top5 = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const portfolio = await pool.query(`SELECT * FROM portfolio LIMIT 1`);
  let cash = portfolio.rows[0].cash;

  // clear positions (simple rebalance)
  await pool.query(`DELETE FROM positions`);

  let invest = cash / top5.length;

  for (let coin of top5) {
    const price = parseFloat(
      prices.find(p => p.symbol === coin.symbol).lastPrice
    );

    const amount = invest / price;

    await pool.query(
      `INSERT INTO positions (symbol, entry, amount)
       VALUES ($1,$2,$3)`,
      [coin.symbol, price, amount]
    );

    await pool.query(
      `INSERT INTO trades (symbol,type,price,pnl)
       VALUES ($1,$2,$3,$4)`,
      [coin.symbol, "BUY", price, 0]
    );
  }

  await pool.query(`UPDATE portfolio SET cash=$1,total=$2`, [0, cash]);

  return top5;
}

// ================= PERFORMANCE =================
async function getPerformance() {
  const t = await pool.query(`SELECT * FROM trades`);

  let wins = 0;
  let losses = 0;

  t.rows.forEach(r => {
    if (r.pnl > 0) wins++;
    else if (r.pnl < 0) losses++;
  });

  let total = wins + losses;

  return {
    trades: total,
    winRate: total === 0 ? 0 : ((wins / total) * 100).toFixed(2)
  };
}

// ================= ROUTES =================
app.get("/", async (req, res) => {
  try {
    await initDB();

    const top5 = await runEngine();

    const positions = await pool.query(`SELECT * FROM positions`);

    const perf = await getPerformance();

    res.send(`
      <h1>🧠 ML Engine v6 (Stable)</h1>

      <p>💰 Trading Top 5 coins dynamically</p>

      <h3>📊 Performance</h3>
      Trades: ${perf.trades}<br/>
      Win Rate: ${perf.winRate}%

      <h3>🏆 Top 5</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.score.toFixed(2)})</div>`).join("")}

      <h3>📦 Positions</h3>
      ${positions.rows.map(p => `<div>${p.symbol}</div>`).join("")}

      <br/><a href="/history">View History</a>
      <br/><a href="/reset">Reset</a>
    `);
  } catch (e) {
    console.error(e);
    res.send("ERROR: " + e.message);
  }
});

// ================= HISTORY =================
app.get("/history", async (req, res) => {
  const t = await pool.query(`SELECT * FROM trades ORDER BY id DESC LIMIT 20`);

  res.send(`
    <h2>📜 Trade History</h2>
    ${t.rows.map(r => `<div>${r.type} ${r.symbol}</div>`).join("")}
    <br/><a href="/">Back</a>
  `);
});

// ================= RESET =================
app.get("/reset", async (req, res) => {
  await pool.query(`DELETE FROM portfolio`);
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`DELETE FROM model`);

  res.send("Reset done. Restart app.");
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
