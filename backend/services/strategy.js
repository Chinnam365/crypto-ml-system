function scoreCoins(coins, weights, momentumMap) {

  return coins.map(c => {

    const m = momentumMap[c.symbol] || 0;

    const crash = (c.change < -8 && m > 0) ? Math.abs(c.change) : 0;

    const score =
      weights.momentum * m +
      weights.crash * crash;

    const strategy = crash > 0 ? "crash" : "momentum";

    return { ...c, score, strategy };
  })
  .sort((a,b)=>b.score-a.score)
  .slice(0,5);
}

module.exports = { scoreCoins };
