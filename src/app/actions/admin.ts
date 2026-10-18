"use server";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { can } from "@/lib/auth/permissions";
import { getDataMode } from "@/lib/env";
import { resetDemoDatabase, withSystem, withUser } from "@/lib/db";
import { todayIST } from "@/lib/dates";
import { loadSnapshots } from "@/lib/data/snapshot";
import { saveForecastSnapshots } from "@/lib/engine/forecasts";
import { audit } from "@/lib/actions/audit";
import { fail, ok } from "@/lib/actions/result";
import { runAction } from "@/lib/actions/run";
import { createSupabaseAdmin } from "@/lib/supabase/admin";
import { facilitySchema, userSchema } from "@/lib/validation/schemas";

export async function saveFacilityAction(input: unknown) {
  return runAction(facilitySchema, input, async (user, d) => {
    if (!can(user, "admin:manage")) return fail("FORBIDDEN");
    // District admins can only manage centres in their own district.
    const districtId = user.districtId ?? d.districtId;
    await withUser(user.id, async (q) => {
      const values = [
        d.code, d.name, d.nameHi, d.facilityType, districtId, d.block, d.address, d.latitude ?? null, d.longitude ?? null,
        d.bedCapacity, d.opdCapacity, d.operationalStatus,
      ];
      if (d.id) {
        const rows = await q.query<{ id: string }>(
          `update public.health_centres set code = $2, name = $3, name_hi = $4, facility_type = $5, district_id = $6,
                  block = $7, address = $8, latitude = $9, longitude = $10, bed_capacity = $11,
                  opd_capacity_per_day = $12, operational_status = $13
            where id = $1 returning id`,
          [d.id, ...values],
        );
        if (!rows[0]) throw new Error("FORBIDDEN");
        await audit(q, user, "facility.updated", "health_centre", d.id, d.id, { code: d.code, status: d.operationalStatus });
      } else {
        const rows = await q.query<{ id: string }>(
          `insert into public.health_centres (code, name, name_hi, facility_type, district_id, block, address, latitude,
              longitude, bed_capacity, opd_capacity_per_day, operational_status, is_demo)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
          [...values, getDataMode() === "demo"],
        );
        await audit(q, user, "facility.created", "health_centre", rows[0].id, rows[0].id, { code: d.code });
      }
    });
    return ok("admin.facilitySaved");
  });
}

export async function saveUserAction(input: unknown) {
  return runAction(userSchema, input, async (user, d) => {
    if (!can(user, "admin:manage")) return fail("FORBIDDEN");
    if (d.id === user.id) return fail("VALIDATION", { role: "admin.cannotEditSelf" });
    const facilityId = d.role === "facility_staff" ? d.facilityId : d.role === "district_admin" ? null : d.facilityId ?? null;

    // Resolve district from the facility (staff) or the admin's own scope.
    const district = await withUser(user.id, async (q) => {
      if (facilityId) {
        const f = await q.query<{ district_id: string }>(`select district_id from public.health_centres where id = $1`, [facilityId]);
        if (!f[0]) throw new Error("FORBIDDEN");
        return f[0].district_id;
      }
      return user.districtId;
    });

    if (d.id) {
      await withUser(user.id, async (q) => {
        const rows = await q.query<{ id: string }>(
          `update public.profiles set full_name = $2, role = $3, facility_id = $4, district_id = $5, is_active = $6
            where id = $1 returning id`,
          [d.id, d.fullName, d.role, facilityId, district, d.isActive],
        );
        if (!rows[0]) throw new Error("FORBIDDEN");
        await audit(q, user, "user.updated", "profile", d.id, facilityId, { role: d.role, active: d.isActive });
      });
      return ok("admin.userSaved");
    }

    // ---- create -----------------------------------------------------------
    let newId: string;
    if (getDataMode() === "supabase") {
      const admin = createSupabaseAdmin();
      if (!admin) return fail("VALIDATION", { email: "admin.supabaseNotConfigured" });
      const { data, error } = await admin.auth.admin.inviteUserByEmail(d.email, { data: { full_name: d.fullName } });
      if (error || !data.user) return fail("DUPLICATE");
      newId = data.user.id;
    } else {
      if (!d.password) return fail("VALIDATION", { password: "validation.passwordMin" });
      newId = randomUUID();
      const exists = await withSystem((q) => q.query(`select 1 from auth.users where lower(email) = lower($1)`, [d.email]));
      if (exists.length) return fail("DUPLICATE");
      await withSystem((q) =>
        q.query(`insert into auth.users (id, email, encrypted_password, raw_user_meta_data) values ($1, $2, $3, $4::jsonb)`, [
          newId, d.email.toLowerCase(), hashPassword(d.password!), JSON.stringify({ full_name: d.fullName }),
        ]),
      );
    }
    try {
      // Profile insert runs under the admin's RLS context (scope enforced).
      await withUser(user.id, async (q) => {
        await q.query(
          `insert into public.profiles (id, email, full_name, role, district_id, facility_id, is_active)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [newId, d.email.toLowerCase(), d.fullName, d.role, district, facilityId, d.isActive],
        );
        await audit(q, user, "user.created", "profile", newId, facilityId, { role: d.role, email: d.email });
      });
    } catch (e) {
      if (getDataMode() === "demo") await withSystem((q) => q.query(`delete from auth.users where id = $1`, [newId]));
      throw e;
    }
    return ok("admin.userSaved");
  });
}

export async function resetDemoAction() {
  return runAction(z.object({}), {}, async (user) => {
    if (!can(user, "demo:reset") || getDataMode() !== "demo") return fail("FORBIDDEN");
    await resetDemoDatabase();
    return ok("demo.resetDone");
  });
}

export async function saveForecastSnapshotAction() {
  return runAction(z.object({}), {}, async (user) => {
    if (!can(user, "forecast:snapshot")) return fail("FORBIDDEN");
    const n = await withUser(user.id, async (q) => {
      const snaps = await loadSnapshots(q, { today: todayIST() });
      const count = await saveForecastSnapshots(q, snaps, user.id);
      await audit(q, user, "forecast.snapshot", "forecasts", null, null, { records: count });
      return count;
    });
    return ok("forecasts.snapshotDone", { n });
  });
}
