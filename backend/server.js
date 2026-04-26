const express = require('express');
const { pool, initDB } = require('./db');
const { safe } = require('./utils/safe');

const { getMarket, getMomentum } = require('./services/market');
const { scoreCoins } = require('./services/strategy');
const { updateWeights } = require('./services/learning');
const { shouldSell } = require('./services/trader');

const app = express();

app.get('/force-reset', async (req,res)=>{
  await pool.query(`DELETE FROM positions`);
  await pool.query(`DELETE FROM trades`);
  await pool.query(`UPDATE portfolio SET capital=100 WHERE id=1`);
  res.send("Reset done");
});

app.get('/', async (req,res)=>{

  await initDB();

  let portfolio = (await pool.query(`SELECT * FROM portfolio WHERE id=1`)).rows[0];
  portfolio.capital = safe(portfolio.capital,100);

  let weights = (await pool.query(`SELECT * FROM model_weights WHERE id=1`)).rows[0];
  weights.momentum = safe(weights.momentum,1);
  weights.crash = safe(weights.crash,1);

  const coins = await getMarket();

  const momentumMap = {};
  for (let c of coins) {
    momentumMap[c.symbol] = await getMomentum(c.symbol);
  }

  const top5 = scoreCoins(coins, weights, momentumMap);

  let positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

  // ===== SELL =====
  for (let p of positions) {

    const coin = coins.find(c=>c.symbol===p.symbol);
    if (!coin) continue;

    const value = safe(p.quantity) * coin.price;
    const pnl = (value - safe(p.capital,1)) / safe(p.capital,1);

    if (shouldSell(pnl, top5.find(c=>c.symbol===p.symbol))) {

      await pool.query(`UPDATE positions SET status='CLOSED' WHERE id=$1`,[p.id]);

      portfolio.capital += value;

      weights = updateWeights(weights, pnl, p.strategy);

      await pool.query(`UPDATE model_weights SET momentum=$1, crash=$2 WHERE id=1`,
        [weights.momentum, weights.crash]);

      await pool.query(`
        INSERT INTO trades(symbol,action,price,capital,pnl,strategy)
        VALUES ($1,'SELL',$2,$3,$4,$5)
      `,[p.symbol,coin.price,value,pnl,p.strategy]);
    }
  }

  // ===== BUY =====
  positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

  const allocation = portfolio.capital / 5;

  for (let c of top5) {

    if (positions.find(p=>p.symbol===c.symbol)) continue;
    if (portfolio.capital < allocation) continue;

    const qty = allocation / c.price;

    portfolio.capital -= allocation;

    await pool.query(`
      INSERT INTO positions(symbol,entry_price,capital,quantity,strategy,status)
      VALUES ($1,$2,$3,$4,$5,'OPEN')
    `,[c.symbol,c.price,allocation,qty,c.strategy]);

    await pool.query(`
      INSERT INTO trades(symbol,action,price,capital,strategy)
      VALUES ($1,'BUY',$2,$3,$4)
    `,[c.symbol,c.price,allocation,c.strategy]);
  }

  // ===== VIEW =====
  positions = (await pool.query(`SELECT * FROM positions WHERE status='OPEN'`)).rows;

  let total = portfolio.capital;

  const view = positions.map(p=>{
    const coin = coins.find(c=>c.symbol===p.symbol);
    if (!coin) return null;

    const value = p.quantity * coin.price;
    total += value;

    const pnl = (value - p.capital)/p.capital;

    return `${p.symbol} (${p.strategy}) ${(pnl*100).toFixed(2)}%`;
  }).filter(Boolean);

  await pool.query(`UPDATE portfolio SET capital=$1 WHERE id=1`,[portfolio.capital]);

  res.send(`
    <body style="background:#0f172a;color:white;padding:20px">
    <h1>🧠 ML Trader v2</h1>

    <div>Total: €${total.toFixed(2)}</div>
    <div>Cash: €${portfolio.capital.toFixed(2)}</div>

    <h3>Weights</h3>
    <div>Momentum: ${weights.momentum.toFixed(2)}</div>
    <div>Crash: ${weights.crash.toFixed(2)}</div>

    <h3>Top 5</h3>
    ${top5.map(c=>`<div>${c.symbol} (${c.strategy})</div>`).join('')}

    <h3>Positions</h3>
    ${view.join('')}

    </body>
  `);
});

app.listen(3000);
