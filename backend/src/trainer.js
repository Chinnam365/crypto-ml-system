const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// sigmoid
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

async function trainModel() {
  console.log("🚀 Training started...");

  // get features
  const { rows } = await pool.query(`
    SELECT f.*, c.close
    FROM features f
    JOIN candles c
    ON f.symbol = c.symbol AND f.time = c.time
    ORDER BY f.time ASC
  `);

  if (rows.length < 100) {
    console.log("Not enough data");
    return;
  }

  // load weights
  const model = await pool.query(`SELECT * FROM model LIMIT 1`);
  let { w1, w2, w3, w4, w5, w6 } = model.rows[0];

  let lr = 0.01; // learning rate

  for (let i = 10; i < rows.length - 5; i++) {
    const r = rows[i];

    // FEATURES
    const f1 = r.macd_hist || 0;
    const f2 = r.momentum || 0;
    const f3 = r.momentum_mid || 0;
    const f4 = r.volume_spike || 0;
    const f5 = r.volatility || 0;
    const f6 = r.dist_low || 0;

    // normalize (important)
    const x = [
      f1 / 100,
      f2,
      f3,
      f4 / 10,
      f5,
      f6
    ];

    // prediction
    const z =
      w1 * x[0] +
      w2 * x[1] +
      w3 * x[2] +
      w4 * x[3] +
      w5 * x[4] +
      w6 * x[5];

    const pred = sigmoid(z);

    // LABEL (future movement)
    const future = rows[i + 3].close;
    const current = r.close;

    const y = future > current * 1.003 ? 1 : 0;

    // ERROR
    const error = y - pred;

    // UPDATE WEIGHTS
    w1 += lr * error * x[0];
    w2 += lr * error * x[1];
    w3 += lr * error * x[2];
    w4 += lr * error * x[3];
    w5 += lr * error * x[4];
    w6 += lr * error * x[5];
  }

  // save weights
  await pool.query(
    `UPDATE model SET w1=$1,w2=$2,w3=$3,w4=$4,w5=$5,w6=$6 WHERE id=1`,
    [w1, w2, w3, w4, w5, w6]
  );

  console.log("✅ Training completed");
  console.log("Weights:", w1, w2, w3, w4, w5, w6);
}

module.exports = { trainModel };
