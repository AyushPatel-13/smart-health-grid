// One-off patch: demo doctor account, doctor directory, and a seeded loan obligation.
import fs from "node:fs";
const f = "src/lib/db/seed.ts";
let s = fs.readFileSync(f, "utf8");
const must = (needle) => {
  if (!s.includes(needle)) throw new Error("missing: " + needle.slice(0, 60));
};

must('  { key: "official", email:');
s = s.replace(
  '  { key: "official", email:',
  '  { key: "doctor", email: `doctor.sundarpur@${DEMO_EMAIL_DOMAIN}`, fullName: "Dr. Meena Joshi (Demo Medical Officer, CHC Sundarpur)", role: "facility_staff", district: "DEMO-SDP", facility: "CHC-SDP-01" },\n  { key: "official", email:',
);

const attAnchor = `    await insertMany(q, "public.attendance",
      ["id", "shift_id", "facility_id", "status", "verification_status", "notes", "recorded_by", "recorded_at", "verified_by", "verified_at"], attRows);`;
must(attAnchor);
s = s.replace(
  attAnchor,
  `${attAnchor}
    // Doctor directory details (fictional) and the demo doctor login.
    await q.query(\`update public.staff set qualification = case designation when 'specialist' then 'MBBS, MD (Demo)' else 'MBBS (Demo)' end,
                     registration_number = 'DEMO-MC-' || substr(employee_code, 5), registration_verified = true
                   where is_doctor\`);
    const [doc] = await q.query<{ id: string }>(
      \`select id from public.staff where facility_id = $1 and designation = 'medical_officer' order by employee_code limit 1\`,
      [facId["CHC-SDP-01"]],
    );
    await q.query(\`update public.staff set profile_id = $2, full_name = 'Dr. Meena Joshi (Demo)' where id = $1\`, [doc.id, userId.doctor]);
    // Guarantee the demo doctor has an unrecorded shift today for the check-in demo.
    await q.query(
      \`insert into public.shifts (facility_id, staff_id, shift_date, shift_type, created_by) values ($1, $2, $3::date, 'on_call', $4)
       on conflict (staff_id, shift_date, shift_type) do nothing\`,
      [facId["CHC-SDP-01"], doc.id, today, adminId],
    );
    await q.query(\`delete from public.attendance where shift_id in (select id from public.shifts where staff_id = $1 and shift_date = $2::date)\`, [doc.id, today]);`,
);

const loanAnchor = "    // Show an in-progress intervention: assign + acknowledge one critical alert.";
must(loanAnchor);
s = s.replace(
  loanAnchor,
  `    // A past emergency loan (CHC Madhuban -> PHC Kishanpur, Paracetamol) run through
    // the real SQL lifecycle as the demo admin: approved -> dispatched -> received ->
    // ledger opened -> lender restoration partially received -> now overdue.
    const [adm] = await q.query<{ id: string }>(\`select id from public.profiles where email = $1\`, [\`admin@\${DEMO_EMAIL_DOMAIN}\`]);
    await q.query(\`select set_config('request.jwt.claims', $1, true)\`, [JSON.stringify({ sub: adm.id, role: "authenticated" })]);
    const [loan] = await q.query<{ id: string }>(
      \`insert into public.transfer_requests (request_code, medicine_id, from_facility_id, to_facility_id, quantity, status, origin, justification,
          requested_by, reviewed_by, reviewed_at, is_loan, decision, urgency, created_at)
       select 'LN-DEMO-0001', m.id, f.id, t.id, 300, 'approved', 'recommendation', 'Emergency loan during fever outbreak (demo)',
              $1, $1, now() - interval '9 days', true, 'emergency_borrow', 'high', now() - interval '9 days'
         from public.medicines m, public.health_centres f, public.health_centres t
        where m.code = 'MED-PCM500' and f.code = 'CHC-SDP-02' and t.code = 'PHC-SDP-07' returning id\`,
      [adm.id],
    );
    await q.query(\`select public.dispatch_transfer($1, 300, null)\`, [loan.id]);
    await q.query(\`select public.receive_transfer($1, 300, null)\`, [loan.id]);
    const [rst] = await q.query<{ id: string }>(
      \`select id from public.replenishment_requests where transfer_id = $1 and purpose = 'lender_restoration'\`,
      [loan.id],
    );
    await q.query(\`select public.receive_replenishment($1, 120, 'PCM500-WH-DEMO1', $2::date, 'Partial warehouse delivery (demo)')\`, [rst.id, addDays(today, 400)]);
    await q.query(\`update public.borrowing_ledger set due_date = $2::date where transfer_id = $1\`, [loan.id, addDays(today, -2)]);
    await q.query(\`update public.replenishment_requests set due_date = $2::date where id = $1\`, [rst.id, addDays(today, -2)]);
    await q.query(\`select set_config('request.jwt.claims', '', true)\`);
    await evaluateAll(q, today);

${loanAnchor}`,
);
fs.writeFileSync(f, s);
console.log("seed patched");

const t = "src/lib/db/types.ts";
let ty = fs.readFileSync(t, "utf8");
ty = ty.replace(
  '"TRANSFER_NOT_DISPATCHED",',
  '"SHIFT_NOT_FOUND", "SHIFT_NOT_TODAY", "NOT_CHECKED_IN", "STAFF_NOT_FOUND", "STAFF_ON_LEAVE", "REASSIGNMENT_OVERLAP", "DONOR_MIN_STAFFING",\n  "TRANSFER_NOT_DISPATCHED",',
);
fs.writeFileSync(t, ty);
console.log("types patched");
