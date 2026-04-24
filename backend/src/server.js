const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

// DB connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize DB
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INT PRIMARY KEY,
      capital FLOAT,
      position TEXT,
      coin TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      action TEXT,
      price FLOAT,
      capital FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  const res = await pool.query(`SELECT * FROM state WHERE id=1`);

  if (res.rows.length === 0) {
    await pool.query(
      `INSERT INTO state (id, capital, position, coin)
       VALUES (1, 100, 'NONE', NULL)`
    );
  }
}

// MAIN DASHBOARD
app.get('/', async (req, res) => {
  try {
    await initDB();

    // Get state
    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    let capital = dbState.rows[0].capital;
    let position = dbState.rows[0].position;
    let currentCoin = dbState.rows[0].coin;

    // Get recent trades
    const tradesResult = await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    );

    // Fetch market data
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    // Filter good coins
    const coins = response.data
      .filter(c =>
        c.symbol.endsWith("USDT") &&
        parseFloat(c.volume) > 1000000 &&
        parseFloat(c.lastPrice) > 0
      )
      .slice(0, 50)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent)
      }));

    // Valid movement filter
    const validCoins = coins.filter(c =>
      Math.abs(c.change) > 1 && Math.abs(c.change) < 5
    );

    const best = validCoins.length > 0
      ? validCoins.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
      : coins[0];

    let action = "HOLD";

    // ===== POSITION LOGIC =====

    // If no position → BUY
    if (position === "NONE") {
      if (best.change > 1 && best.change < 5) {
        capital *= 1.01;
        action = "BUY";
        position = "HOLDING";
        currentCoin = best.symbol;
      }
    }

    // If holding → SELL
    else if (position === "HOLDING") {
      // Only react to same coin
      if (best.symbol === currentCoin && best.change < -1) {
        capital *= 0.99;
        action = "SELL";
        position = "NONE";
        currentCoin = null;
      }
    }

    // Save trade
    if (action !== "HOLD") {
      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital)
         VALUES ($1, $2, $3, $4)`,
        [best.symbol, action, best.price, capital]
      );
    }

    // Update state
    await pool.query(
      `UPDATE state SET capital=$1, position=$2, coin=$3 WHERE id=1`,
      [capital, position, currentCoin]
    );

    // ===== UI =====
    res.send(`
      <html>
      <head>
        <title>Crypto ML Dashboard</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body {
            font-family: Arial;
            background: #0f172a;
            color: white;
            padding: 20px;
          }
          .card {
            background: #1e293b;
            padding: 20px;
            margin-bottom: 15px;
            border-radius: 10px;
          }
          .green { color: #22c55e; }
          .red { color: #ef4444; }
          .yellow { color: #facc15; }
        </style>
      </head>
      <body>

        <h1>🚀 Crypto ML Dashboard</h1>

        <div class="card">
          <h2>💰 Capital: €${capital.toFixed(2)}</h2>
        </div>

        <div class="card">
          <h3>📊 Market Signal</h3>
          <p><b>${best.symbol}</b></p>
          <p>Change: ${best.change.toFixed(2)}%</p>
        </div>

        <div class="card">
          <h3>📌 Position Status</h3>
          <p>Position: ${position}</p>
          <p>Holding Coin: ${currentCoin || "None"}</p>
        </div>

        <div class="card">
          <h3>⚡ Action</h3>
          <p class="${
            action === 'BUY' ? 'green' :
            action === 'SELL' ? 'red' : 'yellow'
          }">
            ${action}
          </p>
        </div>

        <div class="card">
          <h3>📜 Recent Trades</h3>
          <ul>
            ${tradesResult.rows.map(t => `
              <li>
                ${t.action} ${t.symbol} → €${Number(t.capital).toFixed(2)}
              </li>
            `).join('')}
          </ul>
        </div>

      </body>
      </html>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

// HISTORY API
app.get('/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000, () => {
  console.log('Server running');
});
