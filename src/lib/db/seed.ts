// Synthetic, explicitly FICTIONAL demo dataset for Smart Health Grid.
//
// Every facility, person, medicine level and event below is invented for
// demonstration. Nothing here represents real government health data.
//
// The generator is deterministic (fixed PRNG seed) and anchored to "today",
// so re-seeding always yields the same scenario with fresh dates. Inventory is
// produced by SIMULATING 60 days of receipts and FEFO issues, so batch
// balances, the transaction ledger and every derived dashboard metric agree.

import { addDays, istInstant, todayIST, weekday } from "../dates";
import { hashPassword } from "../auth/password";
import { loadSnapshots } from "../data/snapshot";
import { evaluateAll } from "../engine/evaluate";
import { saveForecastSnapshots } from "../engine/forecasts";
import type { DbBackend, Queryable } from "./types";
import { seedPatientsAndAllocation } from "./seed-patients";

export const DEMO_PASSWORD = "Demo@1234";
export const DEMO_EMAIL_DOMAIN = "demo-shg.test";
const HISTORY_DAYS = 60;

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private r: () => number;
  constructor(seed: number) {
    this.r = mulberry32(seed);
  }
  next() {
    return this.r();
  }
  range(a: number, b: number) {
    return a + (b - a) * this.r();
  }
  int(a: number, b: number) {
    return Math.floor(this.range(a, b + 1));
  }
  pick<T>(xs: T[]): T {
    return xs[Math.floor(this.r() * xs.length)];
  }
  /** Stochastic rounding keeps the expected value for small rates. */
  sround(x: number) {
    const f = Math.floor(x);
    return f + (this.r() < x - f ? 1 : 0);
  }
  uuid() {
    const h = Array.from({ length: 32 }, () => Math.floor(this.r() * 16).toString(16));
    h[12] = "4";
    h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------
export interface DemoAccount {
  key: string;
  email: string;
  fullName: string;
  role: "district_admin" | "facility_staff" | "read_only";
  district: string | null;
  facility: string | null;
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { key: "admin", email: `admin@${DEMO_EMAIL_DOMAIN}`, fullName: "Dr. Kavita Rao (Demo District Admin)", role: "district_admin", district: "DEMO-SDP", facility: null },
  { key: "staff_amarpur", email: `staff.amarpur@${DEMO_EMAIL_DOMAIN}`, fullName: "Ravi Kumar (Demo Pharmacist, PHC Amarpur)", role: "facility_staff", district: "DEMO-SDP", facility: "PHC-SDP-01" },
  { key: "staff_chc", email: `staff.sundarpur@${DEMO_EMAIL_DOMAIN}`, fullName: "Sunita Devi (Demo Staff Nurse, CHC Sundarpur)", role: "facility_staff", district: "DEMO-SDP", facility: "CHC-SDP-01" },
  { key: "doctor", email: `doctor.sundarpur@${DEMO_EMAIL_DOMAIN}`, fullName: "Dr. Meena Joshi (Demo Medical Officer, CHC Sundarpur)", role: "facility_staff", district: "DEMO-SDP", facility: "CHC-SDP-01" },
  { key: "official", email: `official@${DEMO_EMAIL_DOMAIN}`, fullName: "A. Mehta (Demo State Observer, read-only)", role: "read_only", district: null, facility: null },
  { key: "admin_rampur", email: `admin.rampur@${DEMO_EMAIL_DOMAIN}`, fullName: "S. Verma (Demo District Admin, Rampur)", role: "district_admin", district: "DEMO-RMP", facility: null },
];

const DISTRICTS = [
  { code: "DEMO-SDP", name: "Sundarpur (Demo District)", name_hi: "सुंदरपुर (डेमो ज़िला)", state: "Demo State (Fictional)" },
  { code: "DEMO-RMP", name: "Rampur (Demo District)", name_hi: "रामपुर (डेमो ज़िला)", state: "Demo State (Fictional)" },
];

interface FacilitySeed {
  code: string;
  name: string;
  name_hi: string;
  type: "PHC" | "CHC";
  district: string;
  block: string;
  lat: number;
  lon: number;
  baseOpd: number;
  opdCapacity: number;
}

const FACILITIES: FacilitySeed[] = [
  { code: "PHC-SDP-01", name: "PHC Amarpur", name_hi: "प्रा.स्वा.के. अमरपुर", type: "PHC", district: "DEMO-SDP", block: "Amarpur", lat: 25.412, lon: 82.031, baseOpd: 94, opdCapacity: 100 },
  { code: "PHC-SDP-02", name: "PHC Belapur", name_hi: "प्रा.स्वा.के. बेलापुर", type: "PHC", district: "DEMO-SDP", block: "Belapur", lat: 25.448, lon: 82.074, baseOpd: 58, opdCapacity: 100 },
  { code: "PHC-SDP-03", name: "PHC Chandpur", name_hi: "प्रा.स्वा.के. चाँदपुर", type: "PHC", district: "DEMO-SDP", block: "Chandpur", lat: 25.371, lon: 82.112, baseOpd: 66, opdCapacity: 100 },
  { code: "PHC-SDP-04", name: "PHC Dharampur", name_hi: "प्रा.स्वा.के. धरमपुर", type: "PHC", district: "DEMO-SDP", block: "Dharampur", lat: 25.502, lon: 81.986, baseOpd: 52, opdCapacity: 90 },
  { code: "PHC-SDP-05", name: "PHC Gopalganj", name_hi: "प्रा.स्वा.के. गोपालगंज", type: "PHC", district: "DEMO-SDP", block: "Gopalganj", lat: 25.336, lon: 82.004, baseOpd: 78, opdCapacity: 100 },
  { code: "PHC-SDP-06", name: "PHC Haripur", name_hi: "प्रा.स्वा.के. हरिपुर", type: "PHC", district: "DEMO-SDP", block: "Haripur", lat: 25.468, lon: 82.158, baseOpd: 49, opdCapacity: 100 },
  { code: "PHC-SDP-07", name: "PHC Kishanpur", name_hi: "प्रा.स्वा.के. किशनपुर", type: "PHC", district: "DEMO-SDP", block: "Kishanpur", lat: 25.392, lon: 81.942, baseOpd: 71, opdCapacity: 100 },
  { code: "PHC-SDP-08", name: "PHC Lalganj", name_hi: "प्रा.स्वा.के. लालगंज", type: "PHC", district: "DEMO-SDP", block: "Lalganj", lat: 25.539, lon: 82.088, baseOpd: 62, opdCapacity: 100 },
  { code: "CHC-SDP-01", name: "CHC Sundarpur Nagar", name_hi: "सा.स्वा.के. सुंदरपुर नगर", type: "CHC", district: "DEMO-SDP", block: "Sundarpur", lat: 25.431, lon: 82.052, baseOpd: 232, opdCapacity: 300 },
  { code: "CHC-SDP-02", name: "CHC Madhuban", name_hi: "सा.स्वा.के. मधुबन", type: "CHC", district: "DEMO-SDP", block: "Madhuban", lat: 25.357, lon: 82.071, baseOpd: 188, opdCapacity: 300 },
  { code: "PHC-RMP-01", name: "PHC Nandgaon", name_hi: "प्रा.स्वा.के. नंदगाँव", type: "PHC", district: "DEMO-RMP", block: "Nandgaon", lat: 25.721, lon: 82.301, baseOpd: 64, opdCapacity: 100 },
  { code: "PHC-RMP-02", name: "PHC Pipariya", name_hi: "प्रा.स्वा.के. पिपरिया", type: "PHC", district: "DEMO-RMP", block: "Pipariya", lat: 25.684, lon: 82.362, baseOpd: 55, opdCapacity: 100 },
  { code: "CHC-RMP-01", name: "CHC Rampur", name_hi: "सा.स्वा.के. रामपुर", type: "CHC", district: "DEMO-RMP", block: "Rampur", lat: 25.702, lon: 82.334, baseOpd: 205, opdCapacity: 300 },
];

interface MedicineSeed {
  code: string;
  name: string;
  name_hi: string;
  unit: string;
  category: string;
  essential: boolean;
  rate: number; // units issued per OPD visit
  chcOnly?: boolean;
}

const MEDICINES: MedicineSeed[] = [
  { code: "MED-PCM500", name: "Paracetamol 500 mg tablet", name_hi: "पैरासिटामोल 500 मि.ग्रा. टैबलेट", unit: "tablet", category: "Analgesic", essential: true, rate: 1.1 },
  { code: "MED-AMX500", name: "Amoxicillin 500 mg capsule", name_hi: "एमोक्सिसिलिन 500 मि.ग्रा. कैप्सूल", unit: "capsule", category: "Antibiotic", essential: true, rate: 0.55 },
  { code: "MED-ORS", name: "ORS sachet (WHO formula)", name_hi: "ओआरएस घोल पैकेट", unit: "sachet", category: "Rehydration", essential: true, rate: 0.16 },
  { code: "MED-ZNC20", name: "Zinc 20 mg dispersible tablet", name_hi: "ज़िंक 20 मि.ग्रा. टैबलेट", unit: "tablet", category: "Supplement", essential: true, rate: 0.12 },
  { code: "MED-IFA", name: "Iron + Folic Acid tablet", name_hi: "आयरन फ़ोलिक एसिड टैबलेट", unit: "tablet", category: "Supplement", essential: true, rate: 0.7 },
  { code: "MED-MET500", name: "Metformin 500 mg tablet", name_hi: "मेटफ़ॉर्मिन 500 मि.ग्रा. टैबलेट", unit: "tablet", category: "Antidiabetic", essential: true, rate: 0.45 },
  { code: "MED-AML5", name: "Amlodipine 5 mg tablet", name_hi: "एम्लोडिपिन 5 मि.ग्रा. टैबलेट", unit: "tablet", category: "Antihypertensive", essential: true, rate: 0.35 },
  { code: "MED-CTX480", name: "Cotrimoxazole 480 mg tablet", name_hi: "कोट्राइमोक्साज़ोल 480 मि.ग्रा. टैबलेट", unit: "tablet", category: "Antibiotic", essential: false, rate: 0.2 },
  { code: "MED-ALB400", name: "Albendazole 400 mg tablet", name_hi: "एल्बेंडाज़ोल 400 मि.ग्रा. टैबलेट", unit: "tablet", category: "Anthelmintic", essential: false, rate: 0.07 },
  { code: "MED-AZI500", name: "Azithromycin 500 mg tablet", name_hi: "एज़िथ्रोमाइसिन 500 मि.ग्रा. टैबलेट", unit: "tablet", category: "Antibiotic", essential: false, rate: 0.09 },
  { code: "MED-SAL-INH", name: "Salbutamol inhaler 100 mcg", name_hi: "साल्बुटामोल इनहेलर 100 माइक्रोग्राम", unit: "inhaler", category: "Respiratory", essential: false, rate: 0.012 },
  { code: "MED-OXY10", name: "Oxytocin 10 IU injection", name_hi: "ऑक्सीटोसिन 10 IU इंजेक्शन", unit: "ampoule", category: "Obstetric", essential: true, rate: 0.012 },
  { code: "MED-RL500", name: "Ringer lactate 500 ml", name_hi: "रिंगर लैक्टेट 500 मि.ली.", unit: "bottle", category: "IV fluid", essential: true, rate: 0.03 },
  { code: "MED-ARV", name: "Anti-rabies vaccine vial", name_hi: "रेबीज़-रोधी टीका", unit: "vial", category: "Vaccine", essential: true, rate: 0.02 },
  { code: "MED-INS40", name: "Human insulin (regular) 40 IU/ml vial", name_hi: "इंसुलिन (रेगुलर) 40 IU/मि.ली.", unit: "vial", category: "Antidiabetic", essential: true, rate: 0.012, chcOnly: true },
];

interface StockScenario {
  targetDays?: number;
  lead?: number;
  stockout?: boolean;
  nearExpiry?: boolean;
  expiredQty?: number;
  recentOnlyDays?: number;
  zeroDemand?: boolean;
  delivery?: { inDays: number; qtyDays: number };
}

// Hand-crafted scenarios so the demo shows every engine behaviour.
const SCENARIOS: Record<string, StockScenario> = {
  "PHC-SDP-01:MED-AMX500": { targetDays: 3, delivery: { inDays: 12, qtyDays: 30 } },
  "PHC-SDP-01:MED-ORS": { stockout: true },
  "PHC-SDP-01:MED-PCM500": { targetDays: 6, delivery: { inDays: 2, qtyDays: 30 } },
  "PHC-SDP-01:MED-IFA": { targetDays: 13 },
  "PHC-SDP-02:MED-AMX500": { targetDays: 170 },
  "PHC-SDP-02:MED-ORS": { targetDays: 130, nearExpiry: true },
  "PHC-SDP-02:MED-PCM500": { targetDays: 95 },
  "PHC-SDP-05:MED-ZNC20": { targetDays: 35, expiredQty: 60 },
  "PHC-SDP-06:MED-IFA": { targetDays: 150 },
  "PHC-SDP-06:MED-ARV": { zeroDemand: true },
  "PHC-SDP-06:MED-PCM500": { targetDays: 110 },
  "PHC-SDP-07:MED-IFA": { targetDays: 5, lead: 14 },
  "PHC-SDP-08:MED-SAL-INH": { recentOnlyDays: 5 },
  "CHC-SDP-01:MED-INS40": { targetDays: 6, lead: 10, delivery: { inDays: 9, qtyDays: 30 } },
  "CHC-SDP-01:MED-RL500": { targetDays: 10 },
  "CHC-SDP-02:MED-INS40": { targetDays: 120 },
  "CHC-SDP-02:MED-AMX500": { targetDays: 95 },
  "CHC-SDP-02:MED-RL500": { targetDays: 90 },
  "CHC-SDP-02:MED-ORS": { targetDays: 75 },
  "PHC-RMP-01:MED-PCM500": { targetDays: 4 },
  "CHC-RMP-01:MED-PCM500": { targetDays: 120 },
};

const DIAGNOSTIC_TESTS = [
  { code: "DX-HB", name: "Haemoglobin estimation", name_hi: "हीमोग्लोबिन जाँच", category: "Haematology", essential: true, chcOnly: false },
  { code: "DX-RBS", name: "Blood glucose (random)", name_hi: "रक्त शर्करा जाँच", category: "Biochemistry", essential: true, chcOnly: false },
  { code: "DX-MAL", name: "Malaria rapid test", name_hi: "मलेरिया रैपिड जाँच", category: "Rapid test", essential: true, chcOnly: false },
  { code: "DX-UPT", name: "Urine pregnancy test", name_hi: "मूत्र गर्भावस्था जाँच", category: "Rapid test", essential: true, chcOnly: false },
  { code: "DX-HIV", name: "HIV rapid test", name_hi: "एचआईवी रैपिड जाँच", category: "Rapid test", essential: true, chcOnly: false },
  { code: "DX-URINE", name: "Urine routine examination", name_hi: "मूत्र सामान्य जाँच", category: "Pathology", essential: false, chcOnly: false },
  { code: "DX-AFB", name: "Sputum AFB microscopy (TB)", name_hi: "बलगम एएफ़बी जाँच (टीबी)", category: "Microbiology", essential: true, chcOnly: false },
  { code: "DX-CBC", name: "Complete blood count", name_hi: "संपूर्ण रक्त गणना", category: "Haematology", essential: true, chcOnly: true },
  { code: "DX-XRAY", name: "Chest X-ray", name_hi: "छाती का एक्स-रे", category: "Radiology", essential: true, chcOnly: true },
  { code: "DX-ECG", name: "ECG", name_hi: "ईसीजी", category: "Cardiology", essential: false, chcOnly: true },
];

const DIAG_OVERRIDES: Record<string, Partial<{ status: "limited" | "unavailable"; reason: string; restriction: string; equipment: string; supplies: string; restoreInDays: number; staleDays: number }>> = {
  "PHC-SDP-01:DX-HB": { status: "unavailable", reason: "Reagent strips exhausted", supplies: "Haemoglobinometer strips (2 boxes)", restoreInDays: 5 },
  "CHC-SDP-01:DX-XRAY": { status: "unavailable", reason: "Equipment fault", equipment: "X-ray tube failure; service engineer requested", restoreInDays: 12 },
  "PHC-SDP-07:DX-AFB": { status: "limited", restriction: "Morning samples only — lab technician shared with another PHC" },
  "PHC-SDP-02:DX-MAL": { staleDays: 12 },
  "PHC-SDP-04:DX-HB": { staleDays: 9 },
  "CHC-RMP-01:DX-ECG": { status: "unavailable", reason: "ECG machine under repair", equipment: "Lead cable damaged" },
  "PHC-SDP-05:DX-HIV": { status: "unavailable", reason: "Test kits out of stock", supplies: "HIV rapid test kits (50)", restoreInDays: 7 },
};

const FIRST = ["Asha", "Rahul", "Pooja", "Vikas", "Neha", "Suresh", "Anita", "Manoj", "Rekha", "Ajay", "Kiran", "Deepak", "Meena", "Arun", "Geeta", "Sanjay", "Priya", "Rakesh", "Shalini", "Naveen"];
const LAST = ["Sharma", "Verma", "Yadav", "Gupta", "Singh", "Mishra", "Patel", "Tiwari", "Pandey", "Chauhan", "Saxena", "Joshi"];

// ---------------------------------------------------------------------------
// Bulk insert helper
// ---------------------------------------------------------------------------
async function insertMany(q: Queryable, table: string, cols: string[], rows: unknown[][], chunk = 400) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const tuples = part.map((r) => {
      const ph = r.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      return `(${ph.join(", ")})`;
    });
    await q.query(`insert into ${table} (${cols.join(", ")}) values ${tuples.join(", ")}`, params);
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
export async function isSeeded(q: Queryable): Promise<boolean> {
  const r = await q.query<{ n: number }>("select count(*)::int as n from public.health_centres");
  return (r[0]?.n ?? 0) > 0;
}

const TOUCH_TRIGGERS: [string, string][] = [
  ["public.patient_daily_stats", "touch_facility_patient_stats"],
  ["public.bed_status", "touch_facility_beds"],
  ["public.diagnostic_services", "touch_facility_diagnostics"],
  ["public.attendance", "touch_facility_attendance"],
  ["public.inventory_transactions", "touch_facility_inventory"],
];

export interface SeedOptions {
  reset?: boolean;
  today?: string;
  /** Supabase mode: auth users already exist; map account key -> auth user id. */
  authUserIds?: Record<string, string>;
}

export async function seedDemoData(backend: DbBackend, opts: SeedOptions = {}): Promise<{ today: string }> {
  const today = opts.today ?? todayIST();
  const g = new Gen(20261018);
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const dayOffset = (i: number) => addDays(today, i - HISTORY_DAYS); // i in [0, HISTORY_DAYS)

  await backend.transaction(async (q) => {
    await q.query(`select set_config('timezone', 'Asia/Kolkata', true)`);
    if (opts.reset) {
      await q.query(`truncate public.audit_logs, public.alert_events, public.alerts, public.forecasts,
        public.transfer_requests, public.inventory_transactions, public.inventory_batches, public.expected_deliveries,
        public.facility_medicines, public.patient_daily_stats, public.bed_status, public.attendance, public.shifts,
        public.staff, public.diagnostic_services, public.diagnostic_tests, public.profiles, public.health_centres,
        public.medicines, public.districts, public.visits, public.queue_counters, public.patient_notifications,
        public.allocation_decisions, public.appointments, public.appointment_requests, public.appointment_slots,
        public.allocation_windows, public.consent_records, public.patients, public.facility_services, public.services
        restart identity cascade`);
      if (!opts.authUserIds) {
        await q.query(`delete from auth.users where email like $1`, [`%@${DEMO_EMAIL_DOMAIN}`]);
      }
    }
    for (const [t, trg] of TOUCH_TRIGGERS) await q.query(`alter table ${t} disable trigger ${trg}`);

    // ---- districts & facilities ------------------------------------------
    const districtId: Record<string, string> = {};
    await insertMany(q, "public.districts", ["id", "code", "name", "name_hi", "state", "is_demo"],
      DISTRICTS.map((d) => {
        districtId[d.code] = g.uuid();
        return [districtId[d.code], d.code, d.name, d.name_hi, d.state, true];
      }));

    const facId: Record<string, string> = {};
    const facRows = FACILITIES.map((f) => {
      facId[f.code] = g.uuid();
      const capacity = f.type === "CHC" ? 40 : 10;
      const lastUpdate = f.code === "PHC-SDP-04" ? hoursAgo(98) : hoursAgo(g.range(1, 9));
      return [facId[f.code], f.code, f.name, f.name_hi, f.type, districtId[f.district], f.block,
        `${f.block} block, ${DISTRICTS.find((d) => d.code === f.district)!.name}`, f.lat, f.lon, capacity,
        f.opdCapacity, f.code === "CHC-SDP-01" ? "limited" : "operational", true, lastUpdate];
    });
    await insertMany(q, "public.health_centres",
      ["id", "code", "name", "name_hi", "facility_type", "district_id", "block", "address", "latitude", "longitude",
        "bed_capacity", "opd_capacity_per_day", "operational_status", "is_demo", "last_data_update"], facRows);

    // ---- users ------------------------------------------------------------
    const userId: Record<string, string> = {};
    for (const a of DEMO_ACCOUNTS) userId[a.key] = opts.authUserIds?.[a.key] ?? g.uuid();
    if (!opts.authUserIds) {
      await insertMany(q, "auth.users", ["id", "email", "encrypted_password", "raw_user_meta_data"],
        DEMO_ACCOUNTS.map((a) => [userId[a.key], a.email, hashPassword(DEMO_PASSWORD), JSON.stringify({ full_name: a.fullName, demo: true })]));
    }
    await insertMany(q, "public.profiles", ["id", "email", "full_name", "role", "district_id", "facility_id"],
      DEMO_ACCOUNTS.map((a) => [userId[a.key], a.email, a.fullName, a.role,
        a.district ? districtId[a.district] : null, a.facility ? facId[a.facility] : null]));
    const adminId = userId.admin;

    // ---- medicines ---------------------------------------------------------
    const medId: Record<string, string> = {};
    await insertMany(q, "public.medicines", ["id", "code", "name", "name_hi", "unit", "category", "is_essential"],
      MEDICINES.map((m) => {
        medId[m.code] = g.uuid();
        return [medId[m.code], m.code, m.name, m.name_hi, m.unit, m.category, m.essential];
      }));

    // ---- footfall -----------------------------------------------------------
    const WEEKDAY = [0.55, 1.25, 1.1, 1.0, 1.0, 0.95, 0.9]; // Sun..Sat
    const opd: Record<string, number[]> = {};
    const statRows: unknown[][] = [];
    for (const f of FACILITIES) {
      const series: number[] = [];
      const trend = g.range(-0.0015, 0.003);
      for (let i = 0; i < HISTORY_DAYS; i++) {
        const day = dayOffset(i);
        let v = f.baseOpd * WEEKDAY[weekday(day)] * (1 + trend * (i - HISTORY_DAYS)) * g.range(0.88, 1.12);
        if (f.code === "PHC-SDP-03" && i >= HISTORY_DAYS - 3) v *= 1.85; // outbreak-like spike
        series.push(Math.max(0, Math.round(v)));
      }
      opd[f.code] = series;
      const lastReported = f.code === "PHC-SDP-04" ? HISTORY_DAYS - 5 : HISTORY_DAYS; // Dharampur stopped reporting
      for (let i = 0; i < lastReported; i++) {
        const v = series[i];
        statRows.push([g.uuid(), facId[f.code], dayOffset(i), v,
          Math.round(v * (f.type === "CHC" ? 0.06 : 0.025) * g.range(0.6, 1.4)),
          Math.round(v * 0.05 * g.range(0.5, 1.5)), adminId]);
      }
    }
    await insertMany(q, "public.patient_daily_stats",
      ["id", "facility_id", "stat_date", "opd_visits", "ipd_admissions", "emergency_visits", "recorded_by"], statRows);

    // ---- inventory simulation ----------------------------------------------
    const fmRows: unknown[][] = [];
    const batchRows: unknown[][] = [];
    const txnRows: unknown[][] = [];
    const deliveryRows: unknown[][] = [];
    const avgDemandBy: Record<string, number> = {};

    for (const f of FACILITIES) {
      for (const m of MEDICINES) {
        if (m.chcOnly && f.type !== "CHC") continue;
        if (m.code === "MED-ARV" && f.type === "PHC" && !["PHC-SDP-01", "PHC-SDP-06", "PHC-RMP-01"].includes(f.code)) continue;
        const key = `${f.code}:${m.code}`;
        const sc = SCENARIOS[key] ?? {};
        const factor = g.range(0.75, 1.25);
        const startIdx = sc.recentOnlyDays ? HISTORY_DAYS - sc.recentOnlyDays : 0;
        const demand = opd[f.code].map((v, i) =>
          sc.zeroDemand || i < startIdx ? 0 : g.sround(v * m.rate * factor * g.range(0.85, 1.15)));
        const last30 = demand.slice(-30);
        const avg = sc.recentOnlyDays
          ? (f.baseOpd * m.rate * factor)
          : last30.reduce((a, b) => a + b, 0) / last30.length;
        avgDemandBy[key] = avg;
        const lead = sc.lead ?? (f.type === "CHC" ? 7 : 10);
        const safety = sc.zeroDemand ? 5 : Math.max(1, Math.ceil(avg * 7));
        fmRows.push([g.uuid(), facId[f.code], medId[m.code], safety, lead]);

        const targetDays = sc.targetDays ?? g.range(28, 80);
        const totalDemand = demand.reduce((a, b) => a + b, 0);
        type SimBatch = { id: string; number: string; qty: number; received: number; expiry: string; receivedIdx: number; source: string };
        const sim: SimBatch[] = [];
        const mkBatch = (receivedIdx: number, qty: number, expiry: string, source = "state_supply"): void => {
          if (qty <= 0) return;
          sim.push({ id: g.uuid(), number: `${m.code.replace("MED-", "")}-${f.code.slice(-2)}${String(sim.length + 1).padStart(2, "0")}-${g.int(100, 999)}`,
            qty, received: qty, expiry, receivedIdx, source });
        };

        if (sc.zeroDemand) {
          mkBatch(0, 40, addDays(today, 300));
        } else if (sc.expiredQty) {
          const expIdx = HISTORY_DAYS - 6; // expired six days ago
          const beforeExp = demand.slice(0, expIdx + 1).reduce((a, b) => a + b, 0);
          mkBatch(0, beforeExp + sc.expiredQty, dayOffset(expIdx));
          const afterExp = demand.slice(expIdx + 1).reduce((a, b) => a + b, 0);
          mkBatch(0, afterExp + Math.round(targetDays * avg), addDays(today, g.int(200, 500)));
        } else if (sc.recentOnlyDays) {
          mkBatch(startIdx, Math.max(10, Math.round(totalDemand + avg * 40)), addDays(today, 400), "local_purchase");
        } else {
          const totalStock = sc.stockout ? Math.max(0, totalDemand - Math.round(avg * 4)) : totalDemand + Math.round(targetDays * avg);
          const q1 = Math.round(totalStock * 0.55);
          mkBatch(0, q1, addDays(today, g.int(150, 500)));
          if (sc.nearExpiry) {
            mkBatch(30, totalStock - q1, addDays(today, 45), "district_warehouse");
          } else {
            mkBatch(30, totalStock - q1, addDays(today, g.int(250, 700)));
          }
        }

        // Day-by-day FEFO simulation
        for (const b of sim) {
          b.qty = 0;
        }
        const ledger: { batch: SimBatch; idx: number; type: string; qty: number; balance: number }[] = [];
        for (let i = 0; i < HISTORY_DAYS; i++) {
          const day = dayOffset(i);
          for (const b of sim) {
            if (b.receivedIdx === i) {
              b.qty += b.received;
              ledger.push({ batch: b, idx: i, type: "receipt", qty: b.received, balance: b.qty });
            }
          }
          let need = demand[i];
          const avail = sim.filter((b) => b.receivedIdx <= i && b.expiry >= day && b.qty > 0).sort((a, b) => a.expiry.localeCompare(b.expiry));
          for (const b of avail) {
            if (need <= 0) break;
            const take = Math.min(b.qty, need);
            b.qty -= take;
            need -= take;
            ledger.push({ batch: b, idx: i, type: "issue", qty: -take, balance: b.qty });
          }
        }
        for (const b of sim) {
          batchRows.push([b.id, facId[f.code], medId[m.code], b.number, b.received, b.qty, b.expiry,
            b.source === "local_purchase" ? "Local chemist (demo)" : "State Medical Supplies Corp. (demo)", b.source,
            istInstant(dayOffset(b.receivedIdx), 10), adminId]);
        }
        let seq = 0;
        for (const l of ledger) {
          seq++;
          txnRows.push([g.uuid(), facId[f.code], medId[m.code], l.batch.id, l.type, l.qty, l.balance,
            l.type === "receipt" ? "Supply received (demo seed)" : "OPD dispensing (demo seed)",
            adminId, istInstant(dayOffset(l.idx), l.type === "receipt" ? 10 : 12, seq % 60)]);
        }
        if (sc.delivery) {
          deliveryRows.push([g.uuid(), facId[f.code], medId[m.code], Math.max(1, Math.round(avg * sc.delivery.qtyDays)),
            addDays(today, sc.delivery.inDays), "State Medical Supplies Corp. (demo)", "pending", adminId]);
        }
      }
    }
    await insertMany(q, "public.facility_medicines", ["id", "facility_id", "medicine_id", "min_safety_stock", "lead_time_days"], fmRows);
    await insertMany(q, "public.inventory_batches",
      ["id", "facility_id", "medicine_id", "batch_number", "quantity_received", "quantity_available", "expiry_date",
        "supplier", "source", "received_at", "created_by"], batchRows);
    await insertMany(q, "public.inventory_transactions",
      ["id", "facility_id", "medicine_id", "batch_id", "txn_type", "quantity", "balance_after", "reason",
        "performed_by", "occurred_at"], txnRows, 500);
    await insertMany(q, "public.expected_deliveries",
      ["id", "facility_id", "medicine_id", "quantity", "expected_date", "source", "status", "created_by"], deliveryRows);

    // ---- beds -----------------------------------------------------------------
    const bedRows: unknown[][] = [];
    for (const f of FACILITIES) {
      const wards = f.type === "CHC"
        ? [{ ward: "General", total: 20 }, { ward: "Maternity", total: 10 }, { ward: "Paediatric", total: 8 }]
        : [{ ward: "General", total: 6 }, { ward: "Maternity", total: 4 }];
      for (const w of wards) {
        let oos = g.next() < 0.2 ? 1 : 0;
        let occ = Math.round((w.total - oos) * g.range(0.35, 0.75));
        if (f.code === "PHC-SDP-05") { oos = w.ward === "General" ? 1 : 0; occ = w.total - oos; }
        if (f.code === "CHC-SDP-01" && w.ward === "Maternity") { oos = 0; occ = 10; }
        if (f.code === "CHC-SDP-01" && w.ward === "General") { oos = 1; occ = 18; }
        if (f.code === "CHC-SDP-01" && w.ward === "Paediatric") { oos = 0; occ = 7; }
        if (f.code === "PHC-SDP-01" && w.ward === "General") { oos = 2; occ = 3; }
        const verified = f.code === "PHC-SDP-04" ? hoursAgo(100) : hoursAgo(g.range(1, 16));
        bedRows.push([g.uuid(), facId[f.code], w.ward, w.total, occ, oos, adminId, verified, verified]);
      }
    }
    await insertMany(q, "public.bed_status",
      ["id", "facility_id", "ward", "total_beds", "occupied_beds", "out_of_service_beds", "updated_by", "verified_at", "updated_at"], bedRows);

    // ---- staff, shifts, attendance -------------------------------------------
    const staffRows: unknown[][] = [];
    const shiftRows: unknown[][] = [];
    const attRows: unknown[][] = [];
    let emp = 0;
    for (const f of FACILITIES) {
      const plan: string[] = f.type === "CHC"
        ? ["medical_officer", "medical_officer", "medical_officer", "specialist", "specialist", "staff_nurse", "staff_nurse",
          "staff_nurse", "staff_nurse", "staff_nurse", "staff_nurse", "pharmacist", "pharmacist", "lab_technician", "lab_technician"]
        : ["medical_officer", "medical_officer", "staff_nurse", "staff_nurse", "pharmacist", "lab_technician", "anm"];
      const counters: Record<string, number> = {};
      for (const designation of plan) {
        const j = (counters[designation] = (counters[designation] ?? 0) + 1) - 1;
        const sid = g.uuid();
        emp++;
        const isDoctor = designation === "medical_officer" || designation === "specialist";
        const name = `${isDoctor ? "Dr. " : ""}${g.pick(FIRST)} ${g.pick(LAST)} (Demo)`;
        staffRows.push([sid, facId[f.code], `EMP-${f.code}-${String(emp).padStart(3, "0")}`, name, designation]);

        for (let d = -13; d <= 6; d++) {
          const day = addDays(today, d);
          const wd = weekday(day);
          let type: string | null = null;
          if (designation === "medical_officer") {
            if (wd === 0) type = (Math.floor((d + 100) / 7) + j) % 2 === 0 ? "on_call" : null;
            else type = j === 0 ? "morning" : j === 1 ? "evening" : (d + j) % 7 === 0 ? null : "night";
          } else if (designation === "specialist") {
            type = wd === 0 ? null : "morning";
          } else if (designation === "staff_nurse") {
            if ((d + 100 + j) % 7 === 6) type = null;
            else type = ["morning", "evening", "night"][(d + 100 + j) % 3];
          } else {
            type = wd === 0 ? null : "morning";
          }
          if (!type) continue;
          const shiftId = g.uuid();
          shiftRows.push([shiftId, facId[f.code], sid, day, type, adminId]);
          if (d > 0) continue;

          // --- attendance outcome ---
          let status: string | null = "present";
          let verified = d <= -3 ? g.next() < 0.97 : g.next() < 0.4;
          const roll = g.next();
          if (roll < 0.02) status = null;
          else if (roll < 0.06) status = "approved_leave";
          else if (roll < 0.09) { status = "absent"; verified = true; }
          if (d === 0) {
            status = type === "morning" && g.next() < 0.75 ? "present" : null;
            verified = false;
          }
          if (f.code === "PHC-SDP-01" && isDoctor && d >= -5 && d <= -1) {
            status = j === 0 ? "absent" : "approved_leave";
            verified = d <= -3;
          }
          if (f.code === "PHC-SDP-07" && isDoctor && d === -3) {
            status = j === 0 ? "absent" : null;
            verified = true;
          }
          if (f.code === "PHC-SDP-08" && d >= -6 && d < 0) {
            const r2 = g.next();
            status = r2 < 0.3 ? null : "present";
            verified = r2 > 0.75;
          }
          if (!status) continue;
          const recordedAt = istInstant(day, type === "morning" ? 9 : type === "evening" ? 15 : 21, 15);
          attRows.push([g.uuid(), shiftId, facId[f.code], status,
            status === "approved_leave" ? "verified" : verified ? "verified" : "unverified",
            status === "approved_leave" ? "Leave approved by MO in-charge (demo)" : null,
            adminId, recordedAt, (status === "approved_leave" || verified) ? adminId : null,
            (status === "approved_leave" || verified) ? istInstant(addDays(day, 1), 11) : null]);
        }
      }
    }
    await insertMany(q, "public.staff", ["id", "facility_id", "employee_code", "full_name", "designation"], staffRows);
    await insertMany(q, "public.shifts", ["id", "facility_id", "staff_id", "shift_date", "shift_type", "created_by"], shiftRows);
    await insertMany(q, "public.attendance",
      ["id", "shift_id", "facility_id", "status", "verification_status", "notes", "recorded_by", "recorded_at", "verified_by", "verified_at"], attRows);
    // Doctor directory details (fictional) and the demo doctor login.
    await q.query(`update public.staff set qualification = case designation when 'specialist' then 'MBBS, MD (Demo)' else 'MBBS (Demo)' end,
                     registration_number = 'DEMO-MC-' || substr(employee_code, 5), registration_verified = true
                   where is_doctor`);
    const [doc] = await q.query<{ id: string }>(
      `select id from public.staff where facility_id = $1 and designation = 'medical_officer' order by employee_code limit 1`,
      [facId["CHC-SDP-01"]],
    );
    await q.query(`update public.staff set profile_id = $2, full_name = 'Dr. Meena Joshi (Demo)' where id = $1`, [doc.id, userId.doctor]);
    // Guarantee the demo doctor has an unrecorded shift today for the check-in demo.
    await q.query(
      `insert into public.shifts (facility_id, staff_id, shift_date, shift_type, created_by) values ($1, $2, $3::date, 'on_call', $4)
       on conflict (staff_id, shift_date, shift_type) do nothing`,
      [facId["CHC-SDP-01"], doc.id, today, adminId],
    );
    await q.query(`delete from public.attendance where shift_id in (select id from public.shifts where staff_id = $1 and shift_date = $2::date)`, [doc.id, today]);

    // ---- diagnostics ----------------------------------------------------------
    const testId: Record<string, string> = {};
    await insertMany(q, "public.diagnostic_tests", ["id", "code", "name", "name_hi", "category", "is_essential"],
      DIAGNOSTIC_TESTS.map((t) => {
        testId[t.code] = g.uuid();
        return [testId[t.code], t.code, t.name, t.name_hi, t.category, t.essential];
      }));
    const diagRows: unknown[][] = [];
    for (const f of FACILITIES) {
      for (const t of DIAGNOSTIC_TESTS) {
        if (t.chcOnly && f.type !== "CHC") continue;
        const o = DIAG_OVERRIDES[`${f.code}:${t.code}`] ?? {};
        const status = o.status ?? "available";
        diagRows.push([g.uuid(), facId[f.code], testId[t.code], status, o.restriction ?? null,
          status === "unavailable" ? o.reason ?? "Not recorded" : null, o.equipment ?? null, o.supplies ?? null,
          o.restoreInDays ? addDays(today, o.restoreInDays) : null,
          o.staleDays ? hoursAgo(o.staleDays * 24) : hoursAgo(g.range(2, 60)), adminId]);
      }
    }
    await insertMany(q, "public.diagnostic_services",
      ["id", "facility_id", "test_id", "status", "restriction_note", "unavailability_reason", "equipment_issue",
        "required_supplies", "estimated_restoration_date", "last_verified_at", "updated_by"], diagRows);

    // ---- patients, services, slots, allocation batches, visits ----------------------
    const staffByFacility: Record<string, string> = {};
    for (const a of DEMO_ACCOUNTS) if (a.facility) staffByFacility[facId[a.facility]] = userId[a.key];
    await seedPatientsAndAllocation(q, adminId, staffByFacility);

    // ---- historical (resolved) alerts and one manual alert ---------------------
    const histAlerts = [
      { fac: "PHC-SDP-02", category: "stock_out", severity: "critical", title: "ORS sachet (WHO formula) is out of stock",
        explanation: "No usable ORS stock remained at PHC Belapur.", daysAgo: 24, resolvedAfter: 2,
        notes: "Replenished from district warehouse (demo)." },
      { fac: "CHC-SDP-02", category: "bed_capacity", severity: "warning", title: "Bed occupancy at 94%",
        explanation: "32 of 34 operational beds occupied.", daysAgo: 15, resolvedAfter: 3,
        notes: "Discharges completed; occupancy normalised (demo)." },
      { fac: "PHC-SDP-06", category: "diagnostic_unavailable", severity: "warning", title: "Malaria rapid test unavailable",
        explanation: "Malaria RDT kits exhausted.", daysAgo: 10, resolvedAfter: 4, notes: "Kits received and verified (demo)." },
    ];
    for (const h of histAlerts) {
      const id = g.uuid();
      const created = hoursAgo(h.daysAgo * 24);
      const resolved = hoursAgo((h.daysAgo - h.resolvedAfter) * 24);
      await q.query(
        `insert into public.alerts (id, facility_id, category, severity, title, explanation, recommended_action, status,
           source, dedupe_key, assigned_to, resolved_at, resolved_by, resolution_notes, created_at, updated_at,
           acknowledged_at, acknowledged_by, supporting_values)
         values ($1,$2,$3,$4,$5,$6,'Historical demo alert','resolved','rule',$7,$8,$9,$8,$10,$11,$9,$11,$8,'{}'::jsonb)`,
        [id, facId[h.fac], h.category, h.severity, h.title, h.explanation, `hist:${id}`, adminId, resolved, h.notes, created]);
      await insertMany(q, "public.alert_events", ["alert_id", "event_type", "actor_id", "notes", "created_at"], [
        [id, "created", null, "Generated by rule engine", created],
        [id, "assigned", adminId, "Assigned to district admin", created],
        [id, "acknowledged", adminId, null, created],
        [id, "resolved", adminId, h.notes, resolved],
      ]);
    }
    const manualId = g.uuid();
    await q.query(
      `insert into public.alerts (id, facility_id, category, severity, title, explanation, recommended_action, status, source,
         assigned_to, created_by, acknowledged_at, acknowledged_by, created_at, supporting_values)
       values ($1, $2, 'manual', 'warning', 'Vaccine refrigerator temperature excursion reported',
         'Facility reported the ILR temperature log above 8°C for ~3 hours overnight (demo report).',
         'Check cold-chain log, move vaccines to backup ILR, request technician visit.', 'acknowledged', 'manual',
         $3, $3, $4, $3, $5, '{}'::jsonb)`,
      [manualId, facId["CHC-SDP-02"], adminId, hoursAgo(20), hoursAgo(26)]);
    await insertMany(q, "public.alert_events", ["alert_id", "event_type", "actor_id", "notes", "created_at"], [
      [manualId, "created", adminId, "Raised manually after phone report", hoursAgo(26)],
      [manualId, "acknowledged", adminId, "Technician requested", hoursAgo(20)],
    ]);

    // ---- transfer requests -----------------------------------------------------
    const orsAvg = avgDemandBy["PHC-SDP-01:MED-ORS"] ?? 10;
    await q.query(
      `insert into public.transfer_requests (id, request_code, medicine_id, from_facility_id, to_facility_id, quantity, status,
         origin, justification, requested_by, created_at)
       values ($1, 'TR-DEMO-0001', $2, null, $3, $4, 'pending', 'manual',
         'ORS exhausted; diarrhoea cases rising in the block (demo request).', $5, $6)`,
      [g.uuid(), medId["MED-ORS"], facId["PHC-SDP-01"], Math.round(orsAvg * 21), userId.staff_amarpur, hoursAgo(20)]);
    await q.query(
      `insert into public.transfer_requests (id, request_code, medicine_id, from_facility_id, to_facility_id, quantity, status,
         origin, justification, requested_by, reviewed_by, reviewed_at, review_notes, created_at)
       values ($1, 'TR-DEMO-0000', $2, $3, $4, 400, 'rejected', 'manual',
         'Precautionary stock for upcoming health camp (demo).', $5, $5, $6,
         'Requesting facility stock adequate; scheduled supply covers the camp.', $7)`,
      [g.uuid(), medId["MED-PCM500"], facId["PHC-SDP-06"], facId["PHC-SDP-07"], adminId, hoursAgo(24 * 6), hoursAgo(24 * 7)]);

    await q.query(
      `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details)
       values (null, 'system', 'demo.seeded', 'database', null, $1::jsonb)`,
      [JSON.stringify({ today, facilities: FACILITIES.length, transactions: txnRows.length, note: "Synthetic demo dataset" })]);

    for (const [t, trg] of TOUCH_TRIGGERS) await q.query(`alter table ${t} enable trigger ${trg}`);
  });

  // ---- derived data: alerts and forecast snapshots from the stored records ----
  await backend.transaction(async (q) => {
    await q.query(`select set_config('timezone', 'Asia/Kolkata', true)`);
    await evaluateAll(q, today);
    await saveForecastSnapshots(q, await loadSnapshots(q, { today }), null);
    // A past emergency loan (CHC Madhuban -> PHC Kishanpur, Paracetamol) run through
    // the real SQL lifecycle as the demo admin: approved -> dispatched -> received ->
    // ledger opened -> lender restoration partially received -> now overdue.
    const [adm] = await q.query<{ id: string }>(`select id from public.profiles where email = $1`, [`admin@${DEMO_EMAIL_DOMAIN}`]);
    await q.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: adm.id, role: "authenticated" })]);
    const [loan] = await q.query<{ id: string }>(
      `insert into public.transfer_requests (request_code, medicine_id, from_facility_id, to_facility_id, quantity, status, origin, justification,
          requested_by, reviewed_by, reviewed_at, is_loan, decision, urgency, created_at)
       select 'LN-DEMO-0001', m.id, f.id, t.id, 300, 'approved', 'recommendation', 'Emergency loan during fever outbreak (demo)',
              $1, $1, now() - interval '9 days', true, 'emergency_borrow', 'high', now() - interval '9 days'
         from public.medicines m, public.health_centres f, public.health_centres t
        where m.code = 'MED-PCM500' and f.code = 'CHC-SDP-02' and t.code = 'PHC-SDP-07' returning id`,
      [adm.id],
    );
    await q.query(`select public.dispatch_transfer($1, 300, null)`, [loan.id]);
    await q.query(`select public.receive_transfer($1, 300, null)`, [loan.id]);
    const [rst] = await q.query<{ id: string }>(
      `select id from public.replenishment_requests where transfer_id = $1 and purpose = 'lender_restoration'`,
      [loan.id],
    );
    await q.query(`select public.receive_replenishment($1, 120, 'PCM500-WH-DEMO1', $2::date, 'Partial warehouse delivery (demo)')`, [rst.id, addDays(today, 400)]);
    await q.query(`update public.borrowing_ledger set due_date = $2::date where transfer_id = $1`, [loan.id, addDays(today, -2)]);
    await q.query(`update public.replenishment_requests set due_date = $2::date where id = $1`, [rst.id, addDays(today, -2)]);
    await q.query(`select set_config('request.jwt.claims', '', true)`);
    await evaluateAll(q, today);

    // Show an in-progress intervention: assign + acknowledge one critical alert.
    const admin = await q.query<{ id: string }>(`select id from public.profiles where email = $1`, [`admin@${DEMO_EMAIL_DOMAIN}`]);
    const crit = await q.query<{ id: string }>(
      `select a.id from public.alerts a join public.health_centres h on h.id = a.facility_id
        where a.category = 'stock_out' and h.code = 'PHC-SDP-01' and a.status = 'open' limit 1`);
    if (admin[0] && crit[0]) {
      await q.query(`update public.alerts set assigned_to = $2, status = 'acknowledged', acknowledged_at = now(),
                     acknowledged_by = $2 where id = $1`, [crit[0].id, admin[0].id]);
      await q.query(`insert into public.alert_events (alert_id, event_type, actor_id, notes) values
                     ($1, 'assigned', $2, 'Assigned to district admin'), ($1, 'acknowledged', $2, 'Transfer being arranged')`,
        [crit[0].id, admin[0].id]);
    }
  });
  return { today };
}
