import type { Metadata } from "next";
import { FacilityFormButton, UserFormButton } from "@/components/forms/admin-forms";
import { ResetDemoButton } from "@/components/forms/misc-buttons";
import { LinkTabs, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/primitives";
import { opStatusTone } from "@/components/ui/tones";
import { requireRole } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { isDemoMode } from "@/lib/env";
import { formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  const user = await requireRole("district_admin");
  const sp = (await searchParams) as Record<string, string | undefined>;
  const tab = sp.tab === "users" ? "users" : "facilities";
  const { t, locale } = await getI18n();
  const demo = isDemoMode();
  const [facilities, districts, users] = await withUser(user.id, async (q) => [
    await q.query<{
      id: string; code: string; name: string; name_hi: string | null; facility_type: "PHC" | "CHC"; district_id: string; district: string;
      block: string | null; address: string | null; latitude: number | null; longitude: number | null; bed_capacity: number;
      opd_capacity_per_day: number; operational_status: "operational" | "limited" | "non_operational";
    }>(
      `select h.id, h.code, h.name, h.name_hi, h.facility_type, h.district_id, d.name as district, h.block, h.address, h.latitude,
              h.longitude, h.bed_capacity, h.opd_capacity_per_day, h.operational_status
         from public.health_centres h join public.districts d on d.id = h.district_id order by h.code`,
    ),
    await q.query<{ id: string; name: string; name_hi: string | null }>(`select id, name, name_hi from public.districts order by name`),
    await q.query<{
      id: string; email: string; full_name: string; role: "district_admin" | "facility_staff" | "read_only"; facility_id: string | null;
      facility: string | null; is_active: boolean;
    }>(
      `select p.id, p.email, p.full_name, p.role, p.facility_id, h.name as facility, p.is_active
         from public.profiles p left join public.health_centres h on h.id = p.facility_id order by p.role, p.full_name`,
    ),
  ]);
  const facOptions = facilities.map((f) => ({ id: f.id, name: `${localName(f, locale)} (${f.code})` }));

  return (
    <>
      <PageHeader title={t("admin.title")} subtitle={t("admin.subtitle")} />
      <LinkTabs
        active={tab}
        tabs={[
          { key: "facilities", label: t("admin.facilitiesTab"), href: "/admin?tab=facilities" },
          { key: "users", label: t("admin.usersTab"), href: "/admin?tab=users" },
        ]}
      />
      {tab === "facilities" ? (
        <Card>
          <CardHeader
            title={t("admin.facilitiesTab")}
            actions={<FacilityFormButton value={null} districts={districts.map((d) => ({ id: d.id, name: localName(d, locale) }))} />}
          />
          <Table>
            <thead>
              <tr>
                <Th>{t("common.code")}</Th>
                <Th>{t("common.name")}</Th>
                <Th>{t("common.district")}</Th>
                <Th align="right">{t("facility.capacity")}</Th>
                <Th align="right">{t("facility.opdCapacity")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>
                  <span className="sr-only">{t("common.actions")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {facilities.map((f) => (
                <tr key={f.id}>
                  <Td className="font-mono text-[12px]">{f.code}</Td>
                  <Td>
                    {localName(f, locale)}
                    <span className="block text-[11px] text-ink-muted">{t(`facilityType.${f.facility_type}Long`)}</span>
                  </Td>
                  <Td className="text-[13px]">{f.district}</Td>
                  <Td align="right">{formatNumber(f.bed_capacity)}</Td>
                  <Td align="right">{formatNumber(f.opd_capacity_per_day)}</Td>
                  <Td>
                    <Badge tone={opStatusTone[f.operational_status]}>{t(`opStatus.${f.operational_status}`)}</Badge>
                  </Td>
                  <Td align="right">
                    <FacilityFormButton
                      districts={districts.map((d) => ({ id: d.id, name: localName(d, locale) }))}
                      value={{
                        id: f.id,
                        code: f.code,
                        name: f.name,
                        nameHi: f.name_hi,
                        facilityType: f.facility_type,
                        districtId: f.district_id,
                        block: f.block,
                        address: f.address,
                        latitude: f.latitude,
                        longitude: f.longitude,
                        bedCapacity: f.bed_capacity,
                        opdCapacity: f.opd_capacity_per_day,
                        operationalStatus: f.operational_status,
                      }}
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : (
        <Card>
          <CardHeader title={t("admin.usersTab")} actions={<UserFormButton value={null} facilities={facOptions} demoMode={demo} />} />
          <Table>
            <thead>
              <tr>
                <Th>{t("common.name")}</Th>
                <Th>{t("admin.role")}</Th>
                <Th>{t("admin.assignedFacility")}</Th>
                <Th>{t("common.status")}</Th>
                <Th>
                  <span className="sr-only">{t("common.actions")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <Td>
                    {u.full_name}
                    <span className="block text-[11px] text-ink-muted">{u.email}</span>
                  </Td>
                  <Td className="text-[13px]">{t(`roles.${u.role}`)}</Td>
                  <Td className="text-[13px]">{u.facility ?? "—"}</Td>
                  <Td>
                    <Badge tone={u.is_active ? "success" : "neutral"}>{u.is_active ? t("admin.active") : t("admin.inactive")}</Badge>
                  </Td>
                  <Td align="right">
                    {u.id !== user.id && (
                      <UserFormButton
                        facilities={facOptions}
                        demoMode={demo}
                        value={{ id: u.id, email: u.email, fullName: u.full_name, role: u.role, facilityId: u.facility_id, isActive: u.is_active }}
                      />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      {demo && (
        <Card className="mt-4">
          <CardHeader title={t("admin.demoTools")} subtitle={t("demo.banner")} />
          <CardBody>
            <ResetDemoButton />
          </CardBody>
        </Card>
      )}
    </>
  );
}
