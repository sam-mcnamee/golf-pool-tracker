import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  competitorToUpdate,
  parseTotalScore,
  resolveCompetitorTotalScore,
  totalScoreFromStatusDetail
} from "./espn-leaderboard-parse.ts";

const schefflerLike = {
  athlete: { id: "9478", displayName: "Scottie Scheffler" },
  score: { value: 67, displayValue: "-3" },
  statistics: [
    { name: "scoreToPar", value: -1, displayValue: "-1" },
    { name: "officialAmount", displayValue: "--" }
  ],
  status: {
    detail: "+2(10)",
    todayDetail: "+2(10)",
    thru: "10",
    period: 2
  },
  linescores: [
    { period: 1, displayValue: "-3", value: 67 },
    { period: 2, displayValue: "+2", value: 40 }
  ]
};

describe("resolveCompetitorTotalScore", () => {
  it("prefers statistics.scoreToPar over score.displayValue and status.detail", () => {
    const result = resolveCompetitorTotalScore(schefflerLike);
    assert.equal(result.totalScore, -1);
    assert.equal(result.source, "scoreToPar");
    assert.equal(totalScoreFromStatusDetail(schefflerLike.status), 2);
  });

  it("falls back to score.displayValue when scoreToPar is missing", () => {
    const row = {
      athlete: { id: "1", displayName: "Test Player" },
      score: { displayValue: "+4" },
      linescores: [{ period: 1, displayValue: "+4" }]
    };
    const result = resolveCompetitorTotalScore(row);
    assert.equal(result.totalScore, 4);
    assert.equal(result.source, "scoreDisplay");
  });
});

describe("competitorToUpdate", () => {
  it("sets overall total from scoreToPar while round columns stay per-round", () => {
    const update = competitorToUpdate(schefflerLike);
    assert.ok(update);
    assert.equal(update.totalScore, -1);
    assert.equal(update.r1Score, -3);
    assert.equal(update.r2Score, 2);
    assert.equal(update.todayScore, 2);
  });

  it("preserves CUT handling from score display", () => {
    const row = {
      athlete: { id: "2", displayName: "Cut Player" },
      score: { displayValue: "CUT" },
      linescores: []
    };
    const update = competitorToUpdate(row);
    assert.ok(update);
    assert.equal(update.totalScore, null);
    assert.equal(update.isCut, false);
  });

  it("detects STATUS_CUT from status.type.name and nulls total_score from scoreToPar", () => {
    // ESPN sends STATUS_CUT in status.type.name, a numeric scoreToPar (2-round total),
    // and sometimes a blank period-3 linescore — all three previously caused false "made cut".
    const row = {
      athlete: { id: "3", displayName: "Viktor Hovland" },
      score: { displayValue: "+5" },
      statistics: [{ name: "scoreToPar", displayValue: "+5" }],
      status: { type: { name: "STATUS_CUT" } },
      linescores: [
        { period: 1, displayValue: "+6", value: 77 },
        { period: 2, displayValue: "-1", value: 70 },
        { period: 3, displayValue: "", value: 0 }
      ]
    };
    const update = competitorToUpdate(row);
    assert.ok(update);
    assert.equal(update.isCut, false, "STATUS_CUT should set isCut=false");
    assert.equal(update.totalScore, null, "cut players must have null totalScore");
    assert.equal(update.r3Score, null, "blank period-3 linescore must not set r3Score");
  });
});

describe("parseTotalScore", () => {
  it("parses E and signed integers", () => {
    assert.deepEqual(parseTotalScore("E"), { totalScore: 0, statusText: null, isCut: null });
    assert.deepEqual(parseTotalScore("+2"), { totalScore: 2, statusText: null, isCut: null });
    assert.deepEqual(parseTotalScore("-13"), { totalScore: -13, statusText: null, isCut: null });
  });
});
