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

// Initialize database
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

    // Get capital
    const dbState = await pool.query(`SELECT * FROM state WHERE id=1`);
    let capital = dbState.rows[0].capital;

    // Fetch market data
    const response = await axios.get(
      'https://api.binance.com/api/v3/ticker/24hr'
    );

    // Prepare coin data
    const coins = response.data.slice(0, 20).map(c => ({
      symbol: c.symbol,
      price: parseFloat(c.lastPrice),
      change: parseFloat(c.priceChangePercent)
    }));

    // Select best opportunity (highest movement)
    const best = coins.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];

    let tradesExecuted = [];
    let action = "HOLD";

    // Decision logic
    if (best.change > 2) {
      capital *= 1.01;
      action = "BUY";
    } else if (best.change < -2) {
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

    // Response
    res.json({
      message: "Smart Trading Engine 🚀",
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
