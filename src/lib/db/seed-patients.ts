// Synthetic (FICTIONAL) patients, services, appointment slots, an already
// processed allocation batch with check-ins, and an OPEN registration window
// with competing requests — so the hourly allocation can be demonstrated live.

import { addDays, todayIST } from "../dates";
import { hashPassword } from "../auth/password";
import type { Queryable } from "./types";
import { claimWindow, processClaimedWindow } from "../allocation/service";
import { tieKey } from "../allocation/engine";

export const DEMO_PATIENT_PIN = "246810";

export const SERVICES = [
  { code: "SVC-OPD", name: "General OPD consultation", name_hi: "सामान्य ओपीडी परामर्श", category: "Outpatient", min: "PHC", test: null, emergency: false, minutes: 7 },
  { code: "SVC-ANC", name: "Antenatal check-up", name_hi: "प्रसवपूर्व जाँच", category: "Maternal health", min: "PHC", test: "DX-UPT", emergency: false, minutes: 12 },
  { code: "SVC-IMM", name: "Child immunisation", name_hi: "बाल टीकाकरण", category: "Child health", min: "PHC", test: null, emergency: false, minutes: 5 },
  { code: "SVC-NCD", name: "Diabetes & BP screening", name_hi: "मधुमेह और रक्तचाप जाँच", category: "NCD", min: "PHC", test: "DX-RBS", emergency: false, minutes: 8 },
  { code: "SVC-TB", name: "TB screening", name_hi: "टीबी जाँच", category: "Communicable disease", min: "PHC", test: "DX-AFB", emergency: false, minutes: 10 },
  { code: "SVC-SPEC", name: "Specialist consultation", name_hi: "विशेषज्ञ परामर्श", category: "Specialist", min: "CHC", test: null, emergency: false, minutes: 15 },
  { code: "SVC-XRAY", name: "Chest X-ray", name_hi: "छाती का एक्स-रे", category: "Radiology", min: "CHC", test: "DX-XRAY", emergency: false, minutes: 10 },
  { code: "SVC-EMG", name: "Emergency care", name_hi: "आपातकालीन देखभाल", category: "Emergency", min: "PHC", test: null, emergency: true, minutes: 20 },
] as const;

/** Fictional localities for approximate-location selection. */
export const LOCALITIES = [
  { name: "Amarpur Bazaar", name_hi: "अमरपुर बाज़ार", lat: 25.415, lon: 82.028 },
  { name: "Amarpur Tola", name_hi: "अमरपुर टोला", lat: 25.405, lon: 82.035 },
  { name: "Rasoolpur", name_hi: "रसूलपुर", lat: 25.421, lon: 82.019 },
  { name: "Kheri", name_hi: "खेड़ी", lat: 25.398, lon: 82.041 },
  { name: "Belapur Chowk", name_hi: "बेलापुर चौक", lat: 25.452, lon: 82.071 },
  { name: "Nayagaon", name_hi: "नयागाँव", lat: 25.437, lon: 82.058 },
  { name: "Sundarpur Station", name_hi: "सुंदरपुर स्टेशन", lat: 25.428, lon: 82.049 },
  { name: "Chandpur Ghat", name_hi: "चाँदपुर घाट", lat: 25.366, lon: 82.109 },
  { name: "Madhuban Colony", name_hi: "मधुबन कॉलोनी", lat: 25.352, lon: 82.068 },
  { name: "Gopalganj Mandi", name_hi: "गोपालगंज मंडी", lat: 25.339, lon: 82.011 },
  { name: "Haripur Kalan", name_hi: "हरिपुर कलां", lat: 25.471, lon: 82.149 },
  { name: "Kishanpur Khurd", name_hi: "किशनपुर खुर्द", lat: 25.389, lon: 81.951 },
  { name: "Lalganj Road", name_hi: "लालगंज रोड", lat: 25.533, lon: 82.081 },
  { name: "Dharampur Village", name_hi: "धरमपुर गाँव", lat: 25.498, lon: 81.991 },
  { name: "Nandgaon Market (Rampur)", name_hi: "नंदगाँव बाज़ार (रामपुर)", lat: 25.718, lon: 82.305 },
];

const NAMES = [
  "Sita Devi", "Ramesh Kumar", "Farida Begum", "Mohan Lal", "Kamla Yadav", "Arjun Singh", "Shabnam Khatoon", "Raju Prasad",
  "Lakshmi Devi", "Imran Ali", "Savitri Bai", "Dinesh Gupta", "Pinky Kumari", "Suresh Pal", "Anjali Mishra", "Gita Rani",
  "Babloo Saini", "Rukhsana Bano", "Om Prakash", "Meera Chauhan", "Sunil Verma", "Nisha Patel", "Harish Tiwari", "Radha Kumari",
  "Vinod Pandey", "Asha Saxena", "Kallu Ram", "Parvati Joshi", "Shyam Sundar", "Jyoti Sharma",
];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seedPatientsAndAllocation(q: Queryable, adminId: string | null, staffByFacility: Record<string, string>) {
  const today = todayIST();
  const r = rng(77);
  const facilities = await q.query<{ id: string; code: string; facility_type: string }>(`select id, code, facility_type from public.health_centres`);
  const tests = await q.query<{ id: string; code: string }>(`select id, code from public.diagnostic_tests`);
  const testId = Object.fromEntries(tests.map((t) => [t.code, t.id]));

  const svcId: Record<string, string> = {};
  for (const s of SERVICES) {
    const [row] = await q.query<{ id: string }>(
      `insert into public.services (code, name, name_hi, category, min_facility_type, required_test_id, is_emergency, avg_consult_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [s.code, s.name, s.name_hi, s.category, s.min, s.test ? testId[s.test] : null, s.emergency, s.minutes],
    );
    svcId[s.code] = row.id;
  }

  const SLOT_PLAN: Record<string, { times: string[]; phc: number; chc: number }> = {
    "SVC-OPD": { times: ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00"], phc: 4, chc: 8 },
    "SVC-ANC": { times: ["10:00", "11:00"], phc: 3, chc: 6 },
    "SVC-IMM": { times: ["09:00", "10:00"], phc: 5, chc: 8 },
    "SVC-NCD": { times: ["11:00", "12:00"], phc: 3, chc: 5 },
    "SVC-TB": { times: ["12:00"], phc: 2, chc: 3 },
    "SVC-SPEC": { times: ["10:00", "11:00", "14:00"], phc: 0, chc: 4 },
    "SVC-XRAY": { times: ["10:00", "14:00"], phc: 0, chc: 6 },
  };
  const fsRows: unknown[][] = [];
  const slotRows: unknown[][] = [];
  for (const f of facilities) {
    for (const s of SERVICES) {
      if (s.min === "CHC" && f.facility_type !== "CHC") continue;
      if (s.code === "SVC-TB" && f.code === "PHC-SDP-04") continue; // Dharampur does not offer TB screening
      fsRows.push([f.id, svcId[s.code]]);
      const plan = SLOT_PLAN[s.code];
      if (!plan) continue;
      for (let d = 0; d <= 2; d++) {
        for (const time of plan.times) {
          const cap = f.facility_type === "CHC" ? plan.chc : plan.phc;
          if (!cap) continue;
          const [hh] = time.split(":").map(Number);
          slotRows.push([f.id, svcId[s.code], addDays(today, d), `${time}:00`, `${String(hh + 1).padStart(2, "0")}:00:00`, cap, adminId]);
        }
      }
    }
  }
  for (const row of fsRows) await q.query(`insert into public.facility_services (facility_id, service_id) values ($1, $2)`, row);
  for (let i = 0; i < slotRows.length; i += 200) {
    const part = slotRows.slice(i, i + 200);
    const params: unknown[] = [];
    const tuples = part.map((row) => `(${row.map((v) => (params.push(v), `$${params.length}`)).join(", ")})`);
    await q.query(
      `insert into public.appointment_slots (facility_id, service_id, slot_date, start_time, end_time, capacity, created_by) values ${tuples.join(", ")}`,
      params,
    );
  }

  // ---- patients ----------------------------------------------------------
  const pinHash = hashPassword(DEMO_PATIENT_PIN);
  const districts = await q.query<{ id: string; code: string }>(`select id, code from public.districts`);
  const sdp = districts.find((d) => d.code === "DEMO-SDP")!.id;
  const rmp = districts.find((d) => d.code === "DEMO-RMP")!.id;
  const patients: { id: string; lat: number; lon: number }[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const loc = LOCALITIES[i % (LOCALITIES.length - 1)];
    const lat = Math.round((loc.lat + (r() - 0.5) * 0.01) * 1000) / 1000;
    const lon = Math.round((loc.lon + (r() - 0.5) * 0.01) * 1000) / 1000;
    const code = `SHG-DEMO${String(i + 1).padStart(4, "0")}`;
    const [row] = await q.query<{ id: string }>(
      `insert into public.patients (patient_code, access_pin_hash, full_name, birth_year, sex, address_text, latitude, longitude,
                                    location_source, district_id, registered_via, is_demo)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'locality', $9, 'self', true) returning id`,
      [code, pinHash, `${NAMES[i]} (Demo)`, 1950 + Math.floor(r() * 55), i % 2 ? "male" : "female", loc.name, lat, lon, loc.name.includes("Rampur") ? rmp : sdp],
    );
    await q.query(
      `insert into public.consent_records (patient_id, consent_type, granted, notice_version)
       values ($1, 'data_processing', true, '2026-10-demo-v1'), ($1, 'location', true, '2026-10-demo-v1')`,
      [row.id],
    );
    patients.push({ id: row.id, lat, lon });
  }

  // ---- a completed batch: today's 14:00 OPD, processed through the real engine ----
  const pastStart = new Date(Date.now() - 3 * 3600_000);
  const [past] = await q.query<{ id: string }>(
    `insert into public.allocation_windows (window_start, cutoff_at, status) values ($1, $2, 'open') returning id`,
    [pastStart.toISOString(), new Date(Date.now() - 2 * 3600_000).toISOString()],
  );
  const pastPatients = patients.slice(0, 14);
  for (const p of pastPatients) {
    const id = crypto.randomUUID();
    await q.query(
      `insert into public.appointment_requests (id, request_code, patient_id, service_id, slot_date, start_time, latitude, longitude, district_id,
                                                window_id, tie_key, idempotency_key, created_at)
       values ($1, $2, $3, $4, $5::date, '14:00', $6, $7, $8, $9, $10, $11, $12)`,
      [id, `REQ-DEMO${id.slice(0, 4).toUpperCase()}`, p.id, svcId["SVC-OPD"], today, p.lat, p.lon, sdp, past.id, tieKey(past.id, id), `seed-past-${id}`, pastStart.toISOString()],
    );
  }
  await claimWindow(q, past.id, "seed");
  await processClaimedWindow(q, past.id);

  // Check in some of those appointments + walk-ins, through the same SQL path
  // staff use (bypassing auth because seeding runs as the system).
  const appts = await q.query<{ id: string; patient_id: string; facility_id: string }>(
    `select id, patient_id, facility_id from public.appointments where window_id = $1 order by rank_at_facility limit 7`,
    [past.id],
  );
  const visitRows: { patient: string; facility: string; appointment: string | null; status: string }[] = [
    ...appts.map((a, i) => ({ patient: a.patient_id, facility: a.facility_id, appointment: a.id, status: i < 2 ? "completed" : i < 4 ? "in_consultation" : "waiting" })),
    ...patients.slice(20, 23).map((p) => ({ patient: p.id, facility: facilities.find((f) => f.code === "PHC-SDP-01")!.id, appointment: null, status: "waiting" })),
  ];
  const counters = new Map<string, number>();
  let seq = 0;
  for (const v of visitRows) {
    seq++;
    const n = (counters.get(v.facility) ?? 0) + 1;
    counters.set(v.facility, n);
    await q.query(
      `insert into public.visits (visit_code, patient_id, facility_id, service_id, appointment_id, visit_date, queue_number, status,
                                  checked_in_at, started_at, completed_at, checked_in_by)
       values ($1, $2, $3, $4, $5, $6::date, $7::int, $8::text, now() - interval '50 minutes' + ($7::int * interval '4 minutes'),
               case when $8::text in ('in_consultation', 'completed') then now() - interval '20 minutes' end,
               case when $8::text = 'completed' then now() - interval '5 minutes' end, $9)`,
      [`V-DEMO-${String(seq).padStart(3, "0")}`, v.patient, v.facility, svcId["SVC-OPD"], v.appointment, today, n, v.status, staffByFacility[v.facility] ?? adminId],
    );
    if (v.appointment) {
      await q.query(`update public.appointments set status = $2 where id = $1`, [v.appointment, v.status === "completed" ? "completed" : "checked_in"]);
    }
  }
  for (const [facility, n] of counters) {
    await q.query(`insert into public.queue_counters (facility_id, visit_date, last_number) values ($1, $2::date, $3)`, [facility, today, n]);
    await q.query(
      `insert into public.patient_daily_stats (facility_id, stat_date, opd_visits, recorded_by, notes) values ($1, $2::date, $3, $4, 'Auto-counted from check-ins')
       on conflict (facility_id, stat_date) do update set opd_visits = public.patient_daily_stats.opd_visits + excluded.opd_visits`,
      [facility, today, n, adminId],
    );
  }

  // ---- the OPEN window: 10 competing requests for tomorrow 10:00 OPD near Amarpur ----
  const tomorrow = addDays(today, 1);
  const nowMs = Date.now();
  const winMs = 60 * 60_000;
  const openStart = new Date(Math.floor((nowMs + 330 * 60_000) / winMs) * winMs - 330 * 60_000);
  const [openWin] = await q.query<{ id: string }>(
    `insert into public.allocation_windows (window_start, cutoff_at, status) values ($1, $2, 'open')
     on conflict (window_start) do update set status = 'open' returning id`,
    [openStart.toISOString(), new Date(openStart.getTime() + winMs).toISOString()],
  );
  const amarpurArea = patients.filter((p) => Math.abs(p.lat - 25.41) < 0.03 && Math.abs(p.lon - 82.03) < 0.03).slice(0, 10);
  const contenders = amarpurArea.length >= 6 ? amarpurArea : patients.slice(14, 24);
  for (const p of contenders) {
    const id = crypto.randomUUID();
    await q.query(
      `insert into public.appointment_requests (id, request_code, patient_id, service_id, slot_date, start_time, latitude, longitude, district_id,
                                                window_id, tie_key, idempotency_key)
       values ($1, $2, $3, $4, $5::date, '10:00', $6, $7, $8, $9, $10, $11)`,
      [id, `REQ-DEMO${id.slice(0, 4).toUpperCase()}`, p.id, svcId["SVC-OPD"], tomorrow, p.lat, p.lon, sdp, openWin.id, tieKey(openWin.id, id), `seed-open-${id}`],
    );
    await q.query(`insert into public.patient_notifications (patient_id, request_id, kind, params) values ($1, $2, 'pending', '{}'::jsonb)`, [p.id, id]);
  }
}
