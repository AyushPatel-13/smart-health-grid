import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Accessibility regression test: reads the REAL design tokens from
// src/app/globals.css and checks WCAG 2.1 contrast for every text/surface
// pairing the UI uses. Small text needs 4.5:1 (SC 1.4.3).

const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const token = (name: string) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token ${name} not found`);
  return m[1];
};

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

describe("WCAG contrast of design tokens", () => {
  it("contrast formula matches known reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  const surfaces = ["surface", "canvas"] as const;
  const texts = ["ink", "ink-muted", "ink-faint", "brand-700", "teal-700"] as const;
  for (const text of texts) {
    for (const bg of surfaces) {
      it(`${text} on ${bg} meets 4.5:1`, () => {
        expect(contrast(token(text), token(bg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("white text on primary and teal buttons meets 4.5:1", () => {
    expect(contrast("#ffffff", token("brand-600"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", token("teal-600"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", token("navy-900"))).toBeGreaterThanOrEqual(4.5);
  });

  it("digital-twin marker labels are readable on every status colour", () => {
    // dark text on good/watch/no-data, white on critical (see app/(app)/twin/page.tsx)
    expect(contrast(token("ink"), "#10b981")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink"), "#f59e0b")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("ink"), "#94a3b8")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", "#dc2626")).toBeGreaterThanOrEqual(4.5);
  });
});
