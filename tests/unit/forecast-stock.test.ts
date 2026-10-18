import { describe, expect, it } from "vitest";
import { detectSpike, forecastSeries, type Point } from "@/lib/analytics/forecast";
import { assessStock, consumptionSeries, usableQuantity } from "@/lib/analytics/stock";
import { addDays } from "@/lib/dates";

const T = "2026-10-18";
const series = (n: number, f: (i: number) => number, end = addDays(T, -1)): Point[] =>
  Array.from({ length: n }, (_, i) => ({ date: addDays(end, i - n + 1), value: f(i) }));

describe("forecastSeries", () => {
  it("refuses to forecast with fewer than 7 points", () => {
    const r = forecastSeries(series(5, () => 10), addDays(T, -1));
    expect(r).toMatchObject({ method: "none", sufficiency: "insufficient", forecast: [], meanDaily: null });
    expect(r.limitations).toContain("forecast.limit.insufficientHistory");
  });

  it("empty history is insufficient (no crash)", () => {
    expect(forecastSeries([], addDays(T, -1)).sufficiency).toBe("insufficient");
  });

  it("uses a rolling mean with limited history and reports no back-test", () => {
    const r = forecastSeries(series(10, () => 20), addDays(T, -1));
    expect(r.sufficiency).toBe("limited");
    expect(r.method).toBe("rolling_mean_7");
    expect(r.backtest).toBeNull();
    expect(r.forecast).toHaveLength(7);
    expect(r.forecast[0].date).toBe(T);
    expect(r.meanDaily).toBe(20);
  });

  it("back-tests against the baseline with sufficient history and learns weekday pattern", () => {
    // Strong weekly cycle: Mondays double.
    const r = forecastSeries(series(56, (i) => (i % 7 === 0 ? 200 : 100)), addDays(T, -1));
    expect(r.sufficiency).toBe("sufficient");
    expect(r.backtest).not.toBeNull();
    expect(r.backtest!.mae).toBeLessThanOrEqual(r.backtest!.baselineMae);
    expect(r.method).toBe("weekday_weighted");
  });

  it("never forecasts negative values and intervals bracket the value", () => {
    const r = forecastSeries(series(30, (i) => (i % 2 ? 0 : 3)), addDays(T, -1));
    for (const f of r.forecast) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.lower).toBeLessThanOrEqual(f.value);
      expect(f.upper).toBeGreaterThanOrEqual(f.value);
    }
  });

  it("flags zero demand", () => {
    expect(forecastSeries(series(30, () => 0), addDays(T, -1)).limitations).toContain("forecast.limit.zeroDemand");
  });

  it("is deterministic", () => {
    const s = series(40, (i) => 50 + (i % 5));
    expect(forecastSeries(s, addDays(T, -1))).toEqual(forecastSeries(s, addDays(T, -1)));
  });
});

describe("detectSpike", () => {
  it("needs at least 15 points", () => {
    expect(detectSpike(series(10, () => 50), 2, 1.3, 28).isSpike).toBe(false);
  });
  it("detects a large jump on the latest day", () => {
    const s = series(30, (i) => (i === 29 ? 200 : 50 + (i % 3)));
    const r = detectSpike(s, 2, 1.3, 28);
    expect(r.isSpike).toBe(true);
    expect(r.ratio).toBeGreaterThan(1.3);
  });
  it("does not flag normal variation", () => {
    expect(detectSpike(series(30, (i) => 50 + (i % 3)), 2, 1.3, 28).isSpike).toBe(false);
  });
});

describe("assessStock", () => {
  const base = { today: T, safetyStock: 70, leadTimeDays: 10, deliveries: [], demandSufficiency: "sufficient" as const };
  const b = (qty: number, days: number) => ({ id: `b${days}`, batchNumber: `B${days}`, quantity: qty, expiryDate: addDays(T, days) });

  it("excludes expired batches from usable stock", () => {
    expect(usableQuantity([b(100, -1), b(50, 10)], T)).toBe(50);
    expect(usableQuantity([b(100, 10), b(50, 40)], T, 30)).toBe(50);
  });

  it("stock_out when nothing usable remains, even with expired stock on shelf", () => {
    const r = assessStock({ ...base, batches: [b(500, -2)], dailyDemand: 10 });
    expect(r.risk).toBe("stock_out");
    expect(r.expired).toBe(500);
    expect(r.usable).toBe(0);
  });

  it("insufficient data when demand is unknown — no misleading projection", () => {
    const r = assessStock({ ...base, batches: [b(100, 100)], dailyDemand: null, demandSufficiency: "insufficient" });
    expect(r.risk).toBe("insufficient_data");
    expect(r.daysRemaining).toBeNull();
  });

  it("no_consumption for zero demand", () => {
    const r = assessStock({ ...base, batches: [b(100, 100)], dailyDemand: 0 });
    expect(r.risk).toBe("no_consumption");
    expect(r.daysRemaining).toBeNull();
  });

  it("critical when stock-out falls within lead time; days remaining = usable / demand", () => {
    const r = assessStock({ ...base, batches: [b(50, 200)], dailyDemand: 10 });
    expect(r.daysRemaining).toBe(5);
    expect(r.daysUntilStockout).toBe(5);
    expect(r.risk).toBe("critical");
  });

  it("boundary: stock-out exactly at lead time is critical; just after is high", () => {
    expect(assessStock({ ...base, batches: [b(100, 200)], dailyDemand: 10 }).risk).toBe("critical"); // day 10
    expect(assessStock({ ...base, batches: [b(110, 200)], dailyDemand: 10 }).risk).toBe("high"); // day 11
  });

  it("a delivery before the stock-out prevents it", () => {
    const r = assessStock({ ...base, batches: [b(60, 200)], dailyDemand: 10, deliveries: [{ quantity: 1000, expectedDate: addDays(T, 3) }] });
    expect(r.projectedStockoutDate).toBeNull();
    expect(r.deliveryBeforeStockout).toBe(true);
  });

  it("batches expiring before use are counted as projected wastage", () => {
    const r = assessStock({ ...base, batches: [b(1000, 5)], dailyDemand: 10 });
    expect(r.projectedWastage).toBeGreaterThan(0);
    expect(r.nearExpiry).toBe(1000);
  });

  it("ok when well stocked", () => {
    expect(assessStock({ ...base, batches: [b(5000, 400)], dailyDemand: 10 }).risk).toBe("ok");
  });
});

describe("consumptionSeries", () => {
  it("excludes stocked-out days (censored) instead of counting them as zero demand", () => {
    const last = addDays(T, -1);
    const moves = [
      { date: addDays(last, -3), issued: 10, net: 10 }, // received 20, issued 10
      { date: addDays(last, -2), issued: 10, net: -10 },
    ];
    const { series: s, censoredDays } = consumptionSeries(moves, 0, addDays(last, -3), last, 56);
    expect(censoredDays).toBe(2);
    expect(s.map((p) => p.value)).toEqual([10, 10]);
  });
  it("returns empty when the item was first stocked after the window end", () => {
    expect(consumptionSeries([], 0, addDays(T, 5), T, 56).series).toEqual([]);
  });
});
