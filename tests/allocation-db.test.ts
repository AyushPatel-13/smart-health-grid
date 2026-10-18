import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { haversineKm } from "@/lib/analytics/redistribution";
import {
  cancelAppointment,
  claimWindow,
  dueWindows,
  markWindowFailed,
  processClaimedWindow,
  submitRequest,
} from "@/lib/allocation/service";
import { addDays, todayIST } from "@/lib/dates";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t?.close();
});

const svc = async (code: string) => (await t.sys((q) => q.query<{ id: string }>(`select id from public.services where code = $1`, [code])))[0].id;
const fac = async (code: string) => (await t.sys((q) => q.query<{ id: string }>(`select id from public.health_centres where code = $1`, [code])))[0].id;

/** Simulate one worker: claim in its own transaction, then process in another. */
async function worker(windowId: string, name: string) {
  const claimed = await t.sys((q) => claimWindow(q, windowId, name));
  if (!claimed) return "not-claimed";
  try {
    await t.sys((q) => processClaimedWindow(q, windowId));
    return "processed";
  } catch (e) {
    await t.sys((q) => markWindowFailed(q, windowId, String(e)));
    return "failed";
  }
}

describe("batch allocation against the database", () => {
  it("processes the open window once even with simultaneous triggers, never overbooks, and is nearest-first", async () => {
    const [win] = await t.sys((q) => q.query<{ id: string }>(`select id from public.allocation_windows where status = 'open' order by window_start desc limit 1`));
    // Simulate reaching the cutoff.
    await t.sys((q) => q.query(`update public.allocation_windows set window_start = least(window_start, now() - interval '2 seconds'), cutoff_at = now() - interval '1 second' where id = $1`, [win.id]));
    const results = await Promise.all([worker(win.id, "scheduler"), worker(win.id, "cron"), worker(win.id, "admin")]);
    expect(results.filter((r) => r === "processed")).toHaveLength(1);

    const [w] = await t.sys((q) => q.query<{ status: string; summary: { requests: number; allocated: number; waitlisted: number } }>(
      `select status, summary from public.allocation_windows where id = $1`, [win.id]));
    expect(w.status).toBe("completed");
    expect(w.summary.allocated + w.summary.waitlisted).toBe(w.summary.requests);

    // No slot anywhere exceeds capacity.
    const over = await t.sys((q) => q.query(`select id from public.appointment_slots where allocated > capacity`));
    expect(over).toHaveLength(0);
    // Exactly one appointment per allocated request.
    const dupes = await t.sys((q) => q.query(`select request_id from public.appointments group by request_id having count(*) > 1`));
    expect(dupes).toHaveLength(0);

    // Stability: no allocated patient has a strictly nearer eligible centre that still has free capacity.
    const appts = await t.sys((q) => q.query<{ request_id: string; distance_km: number; latitude: number; longitude: number; slot_date: string; start_time: string; service_id: string }>(
      `select a.request_id, a.distance_km, r.latitude, r.longitude, a.slot_date, a.start_time::text as start_time, a.service_id
         from public.appointments a join public.appointment_requests r on r.id = a.request_id where a.window_id = $1`, [win.id]));
    for (const a of appts) {
      const free = await t.sys((q) => q.query<{ latitude: number; longitude: number }>(
        `select h.latitude, h.longitude from public.appointment_slots s join public.health_centres h on h.id = s.facility_id
          where s.service_id = $1 and s.slot_date = $2::date and s.start_time = $3::time and s.allocated < s.capacity`,
        [a.service_id, a.slot_date, a.start_time]));
      for (const f of free) {
        const d = haversineKm({ lat: a.latitude, lon: a.longitude }, { lat: f.latitude, lon: f.longitude });
        expect(d).toBeGreaterThanOrEqual(Number(a.distance_km) - 0.01);
      }
    }
    // Re-running a completed window is a no-op (idempotent).
    expect(await worker(win.id, "retry")).toBe("not-claimed");
  });

  it("retries a failed window and completes it", async () => {
    const opd = await svc("SVC-OPD");
    const [patient] = await t.sys((q) => q.query<{ id: string }>(`select id from public.patients order by patient_code offset 25 limit 1`));
    const date = addDays(todayIST(), 2);
    const res = await t.sys((q) => submitRequest(q, { patientId: patient.id, serviceId: opd, slotDate: date, startTime: "15:00:00", preferredFacilityId: null, idempotencyKey: "retry-test-1" }));
    const winId = res.window_id!;
    await t.sys((q) => q.query(`update public.allocation_windows set window_start = least(window_start, now() - interval '2 seconds'), cutoff_at = now() - interval '1 second' where id = $1`, [winId]));
    // First attempt "crashes" after claiming.
    expect(await t.sys((q) => claimWindow(q, winId, "test"))).toBe(true);
    await t.sys((q) => markWindowFailed(q, winId, "simulated network failure"));
    const due = await t.sys((q) => dueWindows(q));
    expect(due.map((d) => d.id)).toContain(winId);
    expect(await worker(winId, "retry")).toBe("processed");
    const [r] = await t.sys((q) => q.query<{ status: string }>(`select status from public.appointment_requests where id = $1`, [res.id]));
    expect(r.status).toBe("allocated");
    const [w] = await t.sys((q) => q.query<{ attempts: number; status: string }>(`select attempts, status from public.allocation_windows where id = $1`, [winId]));
    expect(w).toMatchObject({ attempts: 2, status: "completed" });
  });

  it("duplicate submissions are idempotent and duplicate active requests are rejected", async () => {
    const opd = await svc("SVC-OPD");
    const [patient] = await t.sys((q) => q.query<{ id: string }>(`select id from public.patients order by patient_code offset 26 limit 1`));
    const date = addDays(todayIST(), 2);
    const input = { patientId: patient.id, serviceId: opd, slotDate: date, startTime: "14:00:00", preferredFacilityId: null, idempotencyKey: "dup-key-1" };
    const a = await t.sys((q) => submitRequest(q, input));
    const b = await t.sys((q) => submitRequest(q, input));
    expect(b.duplicate).toBe(true);
    expect(b.id).toBe(a.id);
    await expect(t.sys((q) => submitRequest(q, { ...input, idempotencyKey: "dup-key-2" }))).rejects.toThrow();
  });

  it("cancellation frees the seat and reallocates it to the nearest waitlisted patient", async () => {
    const tb = await svc("SVC-TB");
    const date = addDays(todayIST(), 2);
    // Only Amarpur keeps one TB seat at 12:00; all others closed for this test.
    const amarpur = await fac("PHC-SDP-01");
    await t.sys((q) => q.query(`update public.appointment_slots set capacity = 0 where service_id = $1 and slot_date = $2::date and allocated = 0`, [tb, date]));
    await t.sys((q) => q.query(`update public.appointment_slots set capacity = 1 where service_id = $1 and slot_date = $2::date and facility_id = $3`, [tb, date, amarpur]));
    const pts = await t.sys((q) => q.query<{ id: string }>(`select id from public.patients where address_text like 'Amarpur%' order by patient_code limit 2`));
    const ids: string[] = [];
    let winId = "";
    for (const [i, p] of pts.entries()) {
      const r = await t.sys((q) => submitRequest(q, { patientId: p.id, serviceId: tb, slotDate: date, startTime: "12:00:00", preferredFacilityId: null, idempotencyKey: `tb-${i}` }));
      ids.push(r.id);
      winId = r.window_id!;
    }
    await t.sys((q) => q.query(`update public.allocation_windows set window_start = least(window_start, now() - interval '2 seconds'), cutoff_at = now() - interval '1 second' where id = $1`, [winId]));
    expect(await worker(winId, "test")).toBe("processed");
    const statuses = await t.sys((q) => q.query<{ id: string; status: string }>(`select id, status from public.appointment_requests where id = any($1::uuid[])`, [ids]));
    expect(statuses.map((s) => s.status).sort()).toEqual(["allocated", "waitlisted"]);
    const winner = statuses.find((s) => s.status === "allocated")!.id;
    const loser = statuses.find((s) => s.status === "waitlisted")!.id;
    const [appt] = await t.sys((q) => q.query<{ id: string }>(`select id from public.appointments where request_id = $1`, [winner]));
    await t.sys((q) => cancelAppointment(q, appt.id, "Patient travelling", null));
    const [after] = await t.sys((q) => q.query<{ status: string }>(`select status from public.appointment_requests where id = $1`, [loser]));
    expect(after.status).toBe("allocated");
    const [slotRow] = await t.sys((q) => q.query<{ allocated: number; capacity: number }>(
      `select allocated, capacity from public.appointment_slots where service_id = $1 and slot_date = $2::date and facility_id = $3 and start_time = '12:00'`, [tb, date, amarpur]));
    expect(slotRow).toEqual({ allocated: 1, capacity: 1 });
  });

  it("the database refuses overbooking even if application code is wrong", async () => {
    await expect(t.sys((q) => q.query(`update public.appointment_slots set allocated = capacity + 1 where id = (select id from public.appointment_slots limit 1)`))).rejects.toThrow();
  });

  it("a preferred centre that does not offer the service is rejected", async () => {
    const tbSvc = await svc("SVC-TB");
    const dharampur = await fac("PHC-SDP-04");
    const [p] = await t.sys((q) => q.query<{ id: string }>(`select id from public.patients order by patient_code offset 27 limit 1`));
    await expect(
      t.sys((q) => submitRequest(q, { patientId: p.id, serviceId: tbSvc, slotDate: addDays(todayIST(), 2), startTime: "12:00:00", preferredFacilityId: dharampur, idempotencyKey: "pref-1" })),
    ).rejects.toThrow("PREFERRED_NOT_ELIGIBLE");
  });

  it("emergencies bypass batching and are routed immediately", async () => {
    const emg = await svc("SVC-EMG");
    const [p] = await t.sys((q) => q.query<{ id: string }>(`select id from public.patients order by patient_code offset 28 limit 1`));
    const r = await t.sys((q) => submitRequest(q, { patientId: p.id, serviceId: emg, slotDate: todayIST(), startTime: "00:00", preferredFacilityId: null, idempotencyKey: "emg-1" }));
    expect(r.status).toBe("emergency_referred");
    expect(r.window_id).toBeNull();
  });
});
