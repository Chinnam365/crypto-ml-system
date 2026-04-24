const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const MAX_POSITIONS = 5;

// ===== INIT (SAFE FOR FREE DB) =====
async function initDB() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS positions (
      id SERIAL PRIMARY KEY,
      symbol TEXT,
      entry_price FLOAT,
      capital FLOAT,
      quantity FLOAT,
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
    CREATE TABLE IF NOT EXISTS strategy_perf (
      strategy TEXT PRIMARY KEY,
      total_pnl FLOAT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS equity (
      id SERIAL PRIMARY KEY,
      value FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  // ===== SAFE COLUMN ADD (KEY FIX) =====
  await pool.query(`ALTER TABLE positions ADD COLUMN IF NOT EXISTS strategy TEXT`);
  await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy TEXT`);

  // ===== INIT DATA =====
  await pool.query(`
    INSERT INTO strategy_perf(strategy, total_pnl)
    VALUES ('momentum',0)
    ON CONFLICT DO NOTHING
  `);

  await pool.query(`
    INSERT INTO strategy_perf(strategy, total_pnl)
    VALUES ('crash',0)
    ON CONFLICT DO NOTHING
  `);

  const p = await pool.query(`SELECT * FROM portfolio WHERE id=1`);
  if (p.rows.length === 0) {
    await pool.query(`INSERT INTO portfolio VALUES (1, 100)`);
  }
}

// ===== RESET =====
app.get('/reset', async (req, res) => {
  await initDB();
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`DELETE FROM equity`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  await pool.query(`UPDATE strategy_perf SET total_pnl=0`);
  res.send("Reset complete");
});

// ===== VOLATILITY =====
async function getVolatility(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=10`
    );

    let total = 0;
    res.data.forEach(c => {
      const high = parseFloat(c[2]);
      const low = parseFloat(c[3]);
      total += (high - low) / low;
    });

    return total / res.data.length;
  } catch {
    return 0.02;
  }
}

// ===== SCORES =====
function momentumScore(c) {
  return c.change + Math.log10(c.volume);
}

function crashScore(c) {
  return Math.abs(c.change) * Math.log10(c.volume);
}

// ===== MAIN =====
app.get('/', async (req, res) => {

  if (global.running) return res.send("Processing...");
  global.running = true;

  try {
    await initDB();

    let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];

    const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');

    const btc = response.data.find(c => c.symbol === "BTCUSDT");
    const btcChange = parseFloat(btc.priceChangePercent);

    let regime = "NEUTRAL";
    if (btcChange > 1) regime = "STRONG";
    else if (btcChange < -1) regime = "WEAK";

    // ===== PERFORMANCE =====
    const perf = await pool.query(`SELECT * FROM strategy_perf`);
    const mPerf = perf.rows.find(r => r.strategy === 'momentum')?.total_pnl || 0;
    const cPerf = perf.rows.find(r => r.strategy === 'crash')?.total_pnl || 0;

    const totalPerf = Math.abs(mPerf) + Math.abs(cPerf) + 1;
    const momentumWeight = (mPerf + 1) / totalPerf;
    const crashWeight = (cPerf + 1) / totalPerf;

    // ===== COINS =====
    const coins = response.data
      .filter(c => c.symbol.endsWith("USDT"))
      .map(c => ({
        symbol: c.symbol,
        price: parseFloat(c.lastPrice),
        change: parseFloat(c.priceChangePercent),
        volume: parseFloat(c.quoteVolume)
      }));

    // ===== STRATEGIES =====
    let momentumCoins = coins
      .filter(c => c.change > 1.5 && c.change < 5 && c.volume > 10000000)
      .map(c => ({ ...c, score: momentumScore(c) * (1 + momentumWeight) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    let crashCoins = coins
      .filter(c => c.change < -15 && c.volume > 20000000)
      .map(c => ({ ...c, score: crashScore(c) * (1 + crashWeight) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);

    if (regime === "WEAK") {
      momentumCoins = [];
      crashCoins = crashCoins.slice(0, 1);
    }

    const candidates = [
      ...momentumCoins.map(c => ({ ...c, strategy: 'momentum' })),
      ...crashCoins.map(c => ({ ...c, strategy: 'crash' }))
    ];

    // ===== LOAD POSITIONS (SAFE SELECT) =====
    let positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy, 'momentum') as strategy,
             status
      FROM positions
      WHERE status='OPEN'
    `)).rows;

    let enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== EXIT =====
    for (let pos of enriched) {
      if (pos.pnl >= 0.03 || pos.pnl <= -0.015) {

        await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`, [pos.id]);
        portfolio.capital += pos.value;

        await pool.query(
          `UPDATE strategy_perf SET total_pnl = total_pnl + $1 WHERE strategy=$2`,
          [pos.pnl, pos.strategy]
        );

        await pool.query(
          `INSERT INTO trades(symbol, action, price, capital, pnl, strategy)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            pos.symbol,
            pos.pnl > 0 ? 'SELL (TP)' : 'SELL (SL)',
            pos.price,
            pos.value,
            pos.pnl,
            pos.strategy
          ]
        );
      }
    }

    // refresh
    positions = (await pool.query(`
      SELECT id, symbol, entry_price, capital, quantity,
             COALESCE(strategy, 'momentum') as strategy,
             status
      FROM positions
      WHERE status='OPEN'
    `)).rows;

    enriched = positions.map(p => {
      const coin = coins.find(c => c.symbol === p.symbol);
      if (!coin) return null;

      const value = p.quantity * coin.price;
      const pnl = (value - p.capital) / p.capital;

      return { ...p, value, pnl, price: coin.price };
    }).filter(Boolean);

    // ===== BUY =====
    for (let coin of candidates) {

      if (enriched.find(p => p.symbol === coin.symbol)) continue;
      if (enriched.length >= MAX_POSITIONS) continue;

      const volatility = await getVolatility(coin.symbol);

      let allocation = portfolio.capital * 0.2 * (1 / (volatility + 0.01));

      if (coin.strategy === 'momentum') allocation *= (1 + momentumWeight);
      if (coin.strategy === 'crash') allocation *= (1 + crashWeight * 0.5);

      if (regime === "WEAK") allocation *= 0.3;

      if (allocation < 5) continue;

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

    // ===== TOTAL =====
    let total = portfolio.capital;
    enriched.forEach(p => total += p.value);

    await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`, [portfolio.capital]);

    await pool.query(`INSERT INTO equity(value) VALUES ($1)`, [total]);

    const trades = await pool.query(`SELECT * FROM trades ORDER BY created_at DESC LIMIT 10`);
    const equity = await pool.query(`SELECT * FROM equity ORDER BY created_at ASC LIMIT 50`);

    res.send(`
      <body style="background:#0f172a;color:white;padding:20px;font-family:Arial">
      <h1>📊 ML Dashboard</h1>

      <div>Total: €${total.toFixed(2)}</div>
      <div>Cash: €${portfolio.capital.toFixed(2)}</div>
      <div>BTC: ${btcChange.toFixed(2)}% (${regime})</div>

      <h3>Positions (${enriched.length})</h3>
      ${enriched.map(p => `<div>${p.symbol} (${p.strategy}) ${(p.pnl*100).toFixed(2)}%</div>`).join('')}

      <h3>Recent Trades</h3>
      ${trades.rows.map(t => `<div>${t.action} ${t.symbol}</div>`).join('')}

      <h3>Equity</h3>
      <canvas id="chart"></canvas>

      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script>
      new Chart(document.getElementById('chart'), {
        type: 'line',
        data: {
          labels: ${JSON.stringify(equity.rows.map((_, i) => i))},
          datasets: [{
            label: 'Portfolio',
            data: ${JSON.stringify(equity.rows.map(e => e.value))},
            borderColor: 'lime'
          }]
        }
      });
      </script>

      </body>
    `);

  } catch (err) {
    res.send("Error: " + err.message);
  }

  global.running = false;
});

app.listen(3000);
