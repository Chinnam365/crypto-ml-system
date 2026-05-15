const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let stats = {
  trades: 0,
  wins: 0,
};

let openTrades = [];

// =========================
// INIT DB
// =========================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      exit_price FLOAT,
      result FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("DB ready");
}

// =========================
// FETCH MARKET DATA
// =========================
async function getPrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;

  const response = await axios.get(url);

  return parseFloat(response.data.price);
}

// =========================
// SIMPLE STRATEGY
// =========================
// If BTC moved up slightly,
// simulate a BUY signal.

let lastBTC = null;

async function strategy() {
  try {
    const btc = await getPrice("BTCUSDT");

    if (lastBTC !== null) {
      const change = (btc - lastBTC) / lastBTC;

      // small upward momentum
      if (change > 0.001) {
        console.log("BUY SIGNAL BTC");

        openTrades.push({
          symbol: "BTCUSDT",
          entry: btc,
        });
      }
    }

    lastBTC = btc;

  } catch (err) {
    console.error("Strategy error:", err.message);
  }
}

// =========================
// TRADE MANAGEMENT
// =========================
async function evaluateTrades() {
  try {
    const btc = await getPrice("BTCUSDT");

    let remaining = [];

    for (const trade of openTrades) {

      const change = (btc - trade.entry) / trade.entry;

      // TAKE PROFIT +1%
      if (change >= 0.01) {

        stats.trades++;
        stats.wins++;

        await pool.query(
          `INSERT INTO trades
          (symbol, entry_price, exit_price, result)
          VALUES ($1,$2,$3,$4)`,
          [trade.symbol, trade.entry, btc, 1]
        );

        console.log("WIN");

      }

      // STOP LOSS -0.5%
      else if (change <= -0.005) {

        stats.trades++;

        await pool.query(
          `INSERT INTO trades
          (symbol, entry_price, exit_price, result)
          VALUES ($1,$2,$3,$4)`,
          [trade.symbol, trade.entry, btc, 0]
        );

        console.log("LOSS");

      }

      else {
        remaining.push(trade);
      }
    }

    openTrades = remaining;

  } catch (err) {
    console.error("Trade evaluation error:", err.message);
  }
}

// =========================
// ENGINE LOOP
// =========================
async function runEngine() {
  await strategy();
  await evaluateTrades();

  // cleanup old data
  await pool.query(`
    DELETE FROM trades
    WHERE id NOT IN (
      SELECT id FROM trades
      ORDER BY id DESC
      LIMIT 500
    )
  `);

  console.log(
    `Trades: ${stats.trades} | WinRate: ${
      stats.trades
        ? ((stats.wins / stats.trades) * 100).toFixed(2)
        : 0
    }%`
  );
}

// =========================
// ROUTES
// =========================

app.get("/", (req, res) => {
  res.send(`
    <h1>Crypto ML Phase 2</h1>
    <p>Trades: ${stats.trades}</p>
    <p>Win Rate:
      ${
        stats.trades
          ? ((stats.wins / stats.trades) * 100).toFixed(2)
          : 0
      }%
    </p>

    <a href="/status">Status</a><br/>
    <a href="/history">History</a>
  `);
});

app.get("/status", async (req, res) => {
  const count = await pool.query(
    `SELECT COUNT(*) FROM trades`
  );

  res.json({
    trades: count.rows[0].count,
    winRate:
      stats.trades
        ? ((stats.wins / stats.trades) * 100).toFixed(2)
        : 0,
    openTrades: openTrades.length
  });
});

app.get("/history", async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM trades
     ORDER BY id DESC
     LIMIT 20`
  );

  res.json(result.rows);
});

// =========================
// START SERVER
// =========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log("Server started on", PORT);

  await initDB();

  // run every 15 sec
  setInterval(runEngine, 15000);
});
