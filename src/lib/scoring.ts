import type { RiskInputs, RiskLabel, RiskScoreResult, TokenData } from "./types";

export function calculateRiskScore(input: RiskInputs): RiskScoreResult {
  let score = 0;
  const labels: RiskLabel[] = [];
  const add = (condition: boolean, points: number, label: RiskLabel) => {
    if (condition) { score += points; labels.push(label); }
  };
  add(input.fixedSupply, 15, "fixed_supply");
  add(input.standardTemplate, 15, "standard_template");
  add(input.noBlacklist, 15, "no_blacklist");
  add(input.noHiddenMint, 15, "no_hidden_mint");
  add(input.creatorAllocationPercent < 10, 10, "creator_allocation_low");
  labels.push("creator_allocation_visible");
  add(input.socialsPresent, 5, "socials_present");
  if (!input.socialsPresent) labels.push("missing_socials");
  add(input.verifiedTemplate, 10, "standard_template");
  add(input.holderConcentrationKnown && input.topTenHolderPercent < 35, 10, "low_holder_concentration");
  add(input.previousCleanLaunches > 0, 5, "known_creator");
  if (input.previousCleanLaunches === 0) labels.push("new_creator");
  if (input.creatorAllocationPercent >= 10) labels.push("high_creator_concentration");
  score = Math.min(input.holderConcentrationKnown ? 100 : 79, score);
  const tier = score >= 80 ? "Clean" : score >= 60 ? "Moderate" : score >= 40 ? "High risk" : "Extreme risk";
  if (score < 40) labels.push("high_risk");
  return { score, tier, labels: [...new Set(labels)] };
}

export function calculateMomentumScore(token: TokenData): number {
  const volumeWeight = Math.log10(token.volume1h + 1) * 14;
  const buyerWeight = Math.log10(token.buyers + 1) * 11;
  const tradeWeight = Math.log10(token.trades + 1) * 8;
  const progressWeight = token.crossProgress * 0.24;
  const riskPenalty = (100 - token.riskScore) * 0.18;
  const ageDecay = Math.min(18, token.ageMinutes / 1_440 * 5);
  return Math.max(0, Math.min(100, Math.round(volumeWeight + buyerWeight + tradeWeight + progressWeight - riskPenalty - ageDecay)));
}
