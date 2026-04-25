const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;
const STOP_LOSS = -0.05;
const TAKE_PROFIT = 0.05;

// ===== INIT DB =====
async function initDB() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      capital FLOAT,
      quantity FLOAT,
      strategy TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      action TEXT,
      price FLOAT,
      capital FLOAT,
      pnl FLOAT,
      strategy TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id INT PRIMARY KEY,
      capital FLOAT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS model_weights (
      id INT PRIMARY KEY,
      momentum FLOAT,
      crash FLOAT
    )
  `);

  await pool.query(`
    INSERT INTO model_weights (id, momentum, crash)
    VALUES (1,1,1)
    ON CONFLICT (id) DO NOTHING
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1,100)`);
  }
}

// ===== MOMENTUM =====
async function getMomentum(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=2`
    );
    const prev = parseFloat(res.data[0][4]);
    const last = parseFloat(res.data[1][4]);
    return ((last - prev) / prev) * 100;
  } catch {
    return 0;
  }
}

// ===== ROUTES =====
app.get('/force-reset', async (req, res) => {
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  res.send("Reset complete");
});

app.get('/history', async (req, res) => {
  const trades = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 50`);

  res.send(`
    <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">
    <h2>📜 Trade History</h2>
    ${trades.rows.map(t => `
      <div>
        ${t.action} ${t.symbol} |
        Strategy: ${t.strategy} |
        €${(t.capital || 0).toFixed(2)} |
        ${t.pnl !== null ? (t.pnl*100).toFixed(2)+'%' : ''}
      </div>
    `).join('')}
    </body>
  `);
});

// ===== MAIN =====
app.get('/', async (req, res) => {

  try {

    await initDB();

    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];
    const weights = (await pool.query(`SELECT * FROM model_weights WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const coins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .slice(0, 10)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent)
      }));

    const enrichedCoins = [];

    for (let c of coins) {

      const momentum = await getMomentum(c.symbol);
      const crash = (c.change < -8 && momentum > 0) ? Math.abs(c.change) : 0;

      const score =
        weights.momentum * momentum +
        weights.crash * crash;

      const strategy = crash > 0 ? "crash" : "momentum";

      enrichedCoins.push({ ...c, score, strategy });
    }

    const top5 = enrichedCoins.sort((a, b) => b.score - a.score).slice(0, 5);

    let positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    // ===== EXIT LOGIC =====
    for (let p of positions) {

      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) continue;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      if (pnl <= STOP_LOSS || pnl >= TAKE_PROFIT || !top5.find(c => c.symbol === p.symbol)) {

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [p.id]);

        portfolio.capital += value;

        // ===== LEARNING =====
        const lr = 0.01;

        if (p.strategy === "momentum") {
          weights.momentum += lr * pnl;
        } else {
          weights.crash += lr * pnl;
        }

        await pool.query(`
          UPDATE model_weights
          SET momentum=$1, crash=$2
          WHERE id=1
        `, [weights.momentum, weights.crash]);

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
           VALUES ($1,'SELL',$2,$3,$4,$5)`,
          [p.symbol, coin.price, value, pnl, p.strategy]
        );
      }
    }

    // ===== BUY =====
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    const allocation = portfolio.capital / MAX_POSITIONS;

    for (let coin of top5) {

      if (positions.find(p => p.symbol === coin.symbol)) continue;
      if (portfolio.capital < allocation || allocation <= 0) continue;

      const qty = allocation / coin.price;

      portfolio.capital -= allocation;

      await pool.query(
        `INSERT INTO positions(symbol, entry_price, capital, quantity, strategy, status)
         VALUES ($1,$2,$3,$4,$5,'OPEN')`,
        [coin.symbol, coin.price, allocation, qty, coin.strategy]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, strategy)
         VALUES ($1,'BUY',$2,$3,$4)`,
        [coin.symbol, coin.price, allocation, coin.strategy]
      );
    }

    // ===== FINAL VIEW =====
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    let total = portfolio.capital;

    const enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      total += value;

      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl };
    }).filter(Boolean);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    const trades = await pool.query(`SELECT * FROM trades WHERE action='SELL'`);

    let wins = 0, losses = 0;

    trades.rows.forEach(t => {
      if (t.pnl > 0) wins++;
      else if (t.pnl < 0) losses++;
    });

    const totalTrades = wins + losses;
    const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;

    res.send(`
      <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">

      <h1>🧠 Learning ML Trader</h1>

      <div>💰 Total: €${total.toFixed(2)}</div>
      <div>💵 Cash: €${portfolio.capital.toFixed(2)}</div>

      <h3>📈 Performance</h3>
      <div>Trades: ${totalTrades}</div>
      <div>Win Rate: ${winRate.toFixed(2)}%</div>

      <h3>⚙️ Strategy Weights</h3>
      <div>Momentum: ${weights.momentum.toFixed(2)}</div>
      <div>Crash: ${weights.crash.toFixed(2)}</div>

      <h3>🏆 Top 5</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.strategy})</div>`).join('')}

      <h3>📦 Positions</h3>
      ${enriched.map(p => `
        <div>
        ${p.symbol} (${p.strategy}) |
        ${(p.pnl*100).toFixed(2)}%
        </div>
      `).join('')}

      <h3>📜 <a href="/history" style="color:cyan">View History</a></h3>

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }
});

app.listen(3000);
