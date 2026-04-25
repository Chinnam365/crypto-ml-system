const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;

// ===== CACHE =====
let cache = {};
let cacheTime = 0;
const CACHE_TTL = 60000;

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
      id INT PRIMARY KEY
    )
  `);

  await pool.query(`ALTER TABLE model_weights ADD COLUMN IF NOT EXISTS m5 FLOAT`);
  await pool.query(`ALTER TABLE model_weights ADD COLUMN IF NOT EXISTS recovery FLOAT`);

  await pool.query(`
    INSERT INTO model_weights (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);

  await pool.query(`
    UPDATE model_weights
    SET
      m5 = COALESCE(m5,1),
      recovery = COALESCE(recovery,1)
    WHERE id=1
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }
}

// ===== MOMENTUM =====
async function getMomentum(symbol, interval) {
  const key = symbol + interval;

  if (cache[key] && Date.now() - cacheTime < CACHE_TTL) {
    return cache[key];
  }

  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=2`
    );

    const prev = parseFloat(res.data[0][4]);
    const last = parseFloat(res.data[1][4]);

    const val = ((last - prev) / prev) * 100;

    cache[key] = val;
    cacheTime = Date.now();

    return val;
  } catch {
    return 0;
  }
}

// ===== CLAMP =====
function clamp(v, min = -5, max = 5) {
  return Math.max(min, Math.min(max, v));
}

// ===== FORCE RESET =====
app.get('/force-reset', async (req, res) => {
  global.running = false;

  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);

  res.send("Reset complete");
});

// ===== MAIN =====
app.get('/', async (req, res) => {

  if (global.running) {
    return res.send("⏳ Processing... try again in 5s");
  }

  global.running = true;

  try {

    await initDB();

    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const btc = response.data.find(c => c.symbol === "BTCUSDT");
    const btcChange = parseFloat(btc.priceChangePercent);

    const weights = (await pool.query(`SELECT * FROM model_weights WHERE id=1`)).rows[0];

    const coins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .slice(0, 10)
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    const enrichedCoins = [];

    for (let c of coins) {

      const m5 = await getMomentum(c.symbol, '5m');
      const m24h = c.change;

      const recovery = (m24h < -8 && m5 > 0) ? Math.abs(m24h) : 0;

      const score =
        weights.m5 * m5 +
        weights.recovery * recovery;

      enrichedCoins.push({ ...c, score });
    }

    const top5 = enrichedCoins.sort((a, b) => b.score - a.score).slice(0, 5);

    let positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    let enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin || !p.quantity || !p.capital) return null;

      const value = p.quantity * coin.price;
      if (!isFinite(value)) return null;

      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== SELL =====
    for (let pos of enriched) {
      if (!top5.find(c => c.symbol === pos.symbol)) {

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);

        portfolio.capital += pos.value;

        const lr = 0.001;

        weights.m5 = clamp(weights.m5 + lr * pos.pnl);
        weights.recovery = clamp(weights.recovery + lr * pos.pnl);

        await pool.query(
          `UPDATE model_weights SET m5=$1, recovery=$2 WHERE id=1`,
          [weights.m5, weights.recovery]
        );

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
           VALUES ($1,'SELL',$2,$3,$4,'ml')`,
          [pos.symbol, pos.price, pos.value, pos.pnl]
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
         VALUES ($1,$2,$3,$4,'ml','OPEN')`,
        [coin.symbol, coin.price, allocation, qty]
      );

      await pool.query(
        `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
         VALUES ($1,'BUY',$2,$3,0,'ml')`,
        [coin.symbol, coin.price, allocation]
      );
    }

    // ===== FINAL =====
    positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

    enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl };
    }).filter(Boolean);

    let total = Number(portfolio.capital) || 0;
    enriched.forEach(p => total += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    const trades = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`);

    // ===== PERFORMANCE =====
    const allTrades = await pool.query(`SELECT pnl FROM trades WHERE action='SELL'`);

    let wins = 0, losses = 0, totalPnL = 0;

    allTrades.rows.forEach(t => {
      if (t.pnl > 0) wins++;
      else if (t.pnl < 0) losses++;
      totalPnL += t.pnl || 0;
    });

    const totalTrades = wins + losses;
    const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
    const lossRate = totalTrades ? (losses / totalTrades) * 100 : 0;
    const avgPnL = totalTrades ? (totalPnL / totalTrades) * 100 : 0;

    res.send(`
      <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">

      <h1>🚀 ML Engine (Crash + Momentum)</h1>

      <div>💰 Total: €${total.toFixed(2)}</div>
      <div>💵 Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>📊 BTC: ${btcChange.toFixed(2)}%</div>

      <h3>📈 Performance</h3>
      <div>Total Trades: ${totalTrades}</div>
      <div>✅ Wins: ${winRate.toFixed(2)}%</div>
      <div>❌ Losses: ${lossRate.toFixed(2)}%</div>
      <div>📊 Avg PnL: ${avgPnL.toFixed(2)}%</div>

      <h3>🏆 Top 5</h3>
      ${top5.map(c => `<div>${c.symbol} (${c.score.toFixed(2)})</div>`).join('')}

      <h3>📦 Positions (${enriched.length})</h3>
      ${enriched.map(p => `
        <div>
        ${p.symbol} |
        Entry: ${p.entry_price.toFixed(4)} |
        €${p.capital.toFixed(2)} → €${p.value.toFixed(2)} |
        ${(p.pnl * 100).toFixed(2)}%
        </div>
      `).join('')}

      <h3>📜 Trades</h3>
      ${trades.rows.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  } finally {
    global.running = false;
  }
});

app.listen(3000);
