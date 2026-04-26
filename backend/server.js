const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   DB
========================= */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   INIT TABLES
========================= */

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INT PRIMARY KEY,
      capital FLOAT,
      cash FLOAT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry FLOAT,
      quantity FLOAT,
      capital FLOAT,
      features JSONB,
      time BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      pnl FLOAT,
      result INT,
      time BIGINT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model (
      id INT PRIMARY KEY,
      weights JSONB,
      bias FLOAT
    )
  `);

  // defaults
  await pool.query(`
    INSERT INTO portfolio (id, capital, cash)
    VALUES (1,100,100)
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO model (id, weights, bias)
    VALUES (1,'[0,0,0,0,0]',0)
    ON CONFLICT DO NOTHING
  `);
}

/* =========================
   HELPERS
========================= */

function safe(n, def = 0) {
  return isFinite(n) ? n : def;
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/* =========================
   MARKET DATA
========================= */

async function getKlines(symbol, interval) {
  const res = await axios.get(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=2`
  );

  const prev = parseFloat(res.data[0][4]);
  const curr = parseFloat(res.data[1][4]);

  return safe(((curr - prev) / prev) * 100);
}

async function getMarket(model) {
  const res = await axios.get("https://api.binance.com/api/v3/ticker/24hr");

  const base = res.data
    .filter(c => c.symbol.endsWith("USDT"))
    .filter(c => parseFloat(c.quoteVolume) > 5000000)
    .slice(0, 25);

  const enriched = [];

  for (let c of base) {
    try {
      const [m5, m15, h1, h4] = await Promise.all([
        getKlines(c.symbol, "5m"),
        getKlines(c.symbol, "15m"),
        getKlines(c.symbol, "1h"),
        getKlines(c.symbol, "4h")
      ]);

      const features = [
        safe(m5),
        safe(m15),
        safe(h1),
        safe(h4),
        safe(parseFloat(c.priceChangePercent))
      ];

      const z =
        features.reduce((sum, f, i) => sum + f * model.weights[i], 0) +
        model.bias;

      const probability = sigmoid(z);

      enriched.push({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        features,
        probability
      });

    } catch {}
  }

  return enriched.sort((a, b) => b.probability - a.probability);
}

/* =========================
   TRAIN MODEL
========================= */

function train(model, features, label) {
  const lr = 0.01;

  const z =
    features.reduce((sum, f, i) => sum + f * model.weights[i], 0) +
    model.bias;

  const pred = sigmoid(z);
  const error = label - pred;

  model.weights = model.weights.map((w, i) => w + lr * error * features[i]);
  model.bias += lr * error;

  return model;
}

/* =========================
   MAIN LOOP
========================= */

app.get("/", async (req, res) => {

  await initDB();

  // LOAD STATE
  const pRes = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  let portfolio = pRes.rows[0];

  const mRes = await pool.query(`SELECT * FROM model WHERE id=1`);
  let model = {
    weights: mRes.rows[0].weights,
    bias: mRes.rows[0].bias
  };

  const posRes = await pool.query(`SELECT * FROM positions`);
  let positions = posRes.rows;

  // MARKET
  const coins = await getMarket(model);

  /* ===== BUY ===== */

  if (positions.length < 5) {
    const top = coins.slice(0, 5);

    const allocation = portfolio.cash / 5;

    for (let c of top) {
      if (portfolio.cash < allocation) break;

      const qty = allocation / c.price;

      await pool.query(`
        INSERT INTO positions(symbol, entry, quantity, capital, features, time)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [
        c.symbol,
        c.price,
        qty,
        allocation,
        JSON.stringify(c.features),
        Date.now()
      ]);

      portfolio.cash -= allocation;
    }
  }

  /* ===== UPDATE ===== */

  positions = (await pool.query(`SELECT * FROM positions`)).rows;

  let updated = [];
  let total = portfolio.cash;

  for (let p of positions) {
    const coin = coins.find(c => c.symbol === p.symbol);
    if (!coin) continue;

    const value = p.quantity * coin.price;
    const pnl = (value - p.capital) / p.capital;
    const age = (Date.now() - p.time) / 60000;

    if (pnl > 0.005 || pnl < -0.005 || age > 3) {

      const label = pnl > 0 ? 1 : 0;

      model = train(model, p.features, label);

      await pool.query(`
        INSERT INTO trades(symbol,pnl,result,time)
        VALUES ($1,$2,$3,$4)
      `, [p.symbol, pnl, label, Date.now()]);

      portfolio.cash += value;

    } else {
      updated.push(p);
      total += value;
    }
  }

  // RESET positions table
  await pool.query(`DELETE FROM positions`);

  for (let p of updated) {
    await pool.query(`
      INSERT INTO positions(symbol, entry, quantity, capital, features, time)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [p.symbol, p.entry, p.quantity, p.capital, p.features, p.time]);
  }

  /* ===== SAVE ===== */

  await pool.query(
    `UPDATE portfolio SET cash=$1, capital=$2 WHERE id=1`,
    [portfolio.cash, total]
  );

  await pool.query(
    `UPDATE model SET weights=$1, bias=$2 WHERE id=1`,
    [model.weights, model.bias]
  );

  /* ===== STATS ===== */

  const tRes = await pool.query(`SELECT * FROM trades`);
  const trades = tRes.rows;

  const wins = trades.filter(t => t.result === 1).length;
  const totalTrades = trades.length;

  res.send(`
    <body style="background:#0b1220;color:white;padding:20px;font-family:sans-serif">

    <h1>🧠 ML Engine v6 (Persistent)</h1>

    <p>💰 Total: €${total.toFixed(2)}</p>
    <p>💵 Cash: €${portfolio.cash.toFixed(2)}</p>

    <h3>📊 Performance</h3>
    <p>Trades: ${totalTrades}</p>
    <p>Win Rate: ${totalTrades ? ((wins/totalTrades)*100).toFixed(2) : 0}%</p>

    <h3>🧠 Model</h3>
    <p>${model.weights.map(w=>w.toFixed(3)).join(", ")}</p>

    <h3>🏆 Top Coins</h3>
    ${coins.slice(0,5).map(c =>
      `<p>${c.symbol} (${(c.probability*100).toFixed(1)}%)</p>`
    ).join("")}

    </body>
  `);

});

/* RESET */

app.get("/reset", async (req, res) => {
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`UPDATE portfolio SET capital=100, cash=100`);
  await pool.query(`UPDATE model SET weights='[0,0,0,0,0]', bias=0`);
  res.send("Reset done");
});

app.listen(PORT, () => {
  console.log("Running...");
});
