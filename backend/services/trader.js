const STOP_LOSS = -0.05;
const TAKE_PROFIT = 0.05;

function shouldSell(pnl, inTop5) {
  return pnl <= STOP_LOSS || pnl >= TAKE_PROFIT || !inTop5;
}

module.exports = { shouldSell };
