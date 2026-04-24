const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Initialize DB
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS state (
      id INT PRIMARY KEY,
      capital FLOAT
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
    await pool.query(`INSERT INTO state (id, capital) VALUES (1, 100)`);
  }
}

// MAIN ROUTE
app.get('/', async (req, res) => {
  try {
    await initDB();

    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    let capital = dbState.rows[0].capital;

    const trades = await pool.query(
      `SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`
    );

    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

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

    const filtered = coins.filter(c =>
      Math.abs(c.change) > 1 &&
      Math.abs(c.change) < 5
    );

    const best = filtered.length > 0
      ? filtered.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
      : coins[0];

    let action = "HOLD";

    if (best.change > 1 && best.change < 5) {
      capital *= 1.01;
      action = "BUY";
    } else if (best.change < -1 && best.change > -5) {
      capital *= 0.99;
      action = "SELL";
    }

    if (action !== "HOLD") {
      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital)
         VALUES ($1, $2, $3, $4)`,
        [best.symbol, action, best.price, capital]
      );
    }

    await pool.query(
      `UPDATE state SET capital=$1 WHERE id=1`,
      [capital]
    );

    // HTML UI
    res.send(`
      <html>
      <head>
        <title>Crypto ML Dashboard</title>
        <meta http-equiv="refresh" content="5">
        <style>
          body { font-family: Arial; padding: 20px; background:#111; color:#eee; }
          .card { background:#1e1e1e; padding:20px; margin:10px 0; border-radius:10px; }
          .green { color:#00ff99; }
          .red { color:#ff4d4d; }
        </style>
      </head>
      <body>

        <h1>🚀 Crypto ML Dashboard</h1>

        <div class="card">
          <h2>💰 Capital: €${capital.toFixed(2)}</h2>
        </div>

        <div class="card">
          <h2>📊 Selected Coin: ${best.symbol}</h2>
          <p>Change: ${best.change.toFixed(2)}%</p>
          <p>Action: <b class="${action === 'BUY' ? 'green' : action === 'SELL' ? 'red' : ''}">
            ${action}
          </b></p>
        </div>

        <div class="card">
          <h2>📜 Recent Trades</h2>
          <ul>
            ${trades.rows.map(t => `
              <li>${t.action} ${t.symbol} | €${t.capital.toFixed(2)}</li>
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
  try {
    await initDB();

    // Get capital
    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    let capital = dbState.rows[0].capital;

    // Fetch Binance data
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
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.volume)
      }));

    // Pick best (by movement)
    const filtered = coins.filter(c =>
  Math.abs(c.change) > 1 &&     // meaningful move
  Math.abs(c.change) < 5        // not too extreme
);

const best = filtered.length > 0
  ? filtered.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0]
  : coins[0]; // fallback

    let action = "HOLD";
    let tradesExecuted = [];

    // Improved decision logic
    if (Math.abs(best.change) > 15) {
      action = "HOLD"; // ignore extreme spikes
    } else if (best.change > 1 && best.change < 5) {
      capital *= 1.01;
      action = "BUY";
    } else if (best.change < -1 && best.change > -5) {
      capital *= 0.99;
      action = "SELL";
    }

    // Save trade if executed
    if (action !== "HOLD") {
      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital)
         VALUES ($1, $2, $3, $4)`,
        [best.symbol, action, best.price, capital]
      );

      tradesExecuted.push(`${action} ${best.symbol}`);
    }

    // Update capital
    await pool.query(
      `UPDATE state SET capital=$1 WHERE id=1`,
      [capital]
    );

    res.json({
      message: "Smart Trading Engine v2 🚀",
      capital: capital.toFixed(2),
      selectedCoin: best.symbol,
      change: best.change,
      action: action,
      tradesExecuted
    });

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

// TRADE HISTORY
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
