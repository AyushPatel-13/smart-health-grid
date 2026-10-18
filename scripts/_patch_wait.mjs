import fs from "node:fs";
const edit = (file, pairs) => {
  let s = fs.readFileSync(file, "utf8");
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${file}: missing ${a.slice(0, 70)}`);
    s = s.replace(a, b);
  }
  fs.writeFileSync(file, s);
  console.log("patched", file);
};
edit("src/app/(app)/queue/page.tsx", [
  ['import { getI18n } from "@/lib/i18n/server";', 'import { getI18n } from "@/lib/i18n/server";\nimport { loadLiveQueues } from "@/lib/operations/live";'],
  ['  const active = visits.filter((v) => v.status !== "cancelled");',
   '  const active = visits.filter((v) => v.status !== "cancelled");\n  const live = (await withUser(user.id, (q) => loadLiveQueues(q, [facilityId], today))).get(facilityId)!;'],
  ['      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">',
   '      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">'],
  ['        <KpiCard label={t("queue.expectedTomorrow")} value={tomorrow.n} sub={t("queue.bookings")} />',
   '        <KpiCard label={t("queue.expectedTomorrow")} value={tomorrow.n} sub={t("queue.bookings")} />\n        <KpiCard\n          label={t("overload.estWait")}\n          value={live.estWaitMinutes === null ? "—" : `${live.estWaitMinutes} min`}\n          sub={`${tx(`overload.basis.${live.waitBasis}`)} · ${live.doctorsVerifiedNow}/${live.doctorsRosteredNow} · ${live.consultMinutes} min/${tx(`overload.consult.${live.consultMinutesSource}`)}`}\n          tone={live.estWaitMinutes === null ? "critical" : live.estWaitMinutes > 60 ? "warning" : "teal"}\n        />'],
]);
edit("src/lib/allocation/recommend.ts", [
  ['import type { Queryable } from "../db/types";', 'import type { Queryable } from "../db/types";\nimport { loadLiveQueues } from "../operations/live";'],
  ['  return rows\n    .map((r) => {', '  const live = input.date === today ? await loadLiveQueues(q, rows.map((r) => r.id), today) : null;\n  return rows\n    .map((r) => {'],
  ['      if (coverage !== null && coverage < 70) notes.push({ key: "patient.reason.lowCoverage" });',
   '      if (coverage !== null && coverage < 70) notes.push({ key: "patient.reason.lowCoverage" });\n      const lv = live?.get(r.id);\n      if (lv) notes.push(lv.estWaitMinutes === null ? { key: "patient.reason.noDoctorNow" } : { key: "patient.reason.estWait", params: { min: lv.estWaitMinutes } });'],
]);
