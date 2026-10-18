"use client";

import { Printer } from "lucide-react";
import { buttonClass } from "./primitives";

export function PrintButton({ label }: { label: string }) {
  return (
    <button type="button" className={buttonClass("secondary")} onClick={() => window.print()}>
      <Printer className="size-4" aria-hidden />
      {label}
    </button>
  );
}
