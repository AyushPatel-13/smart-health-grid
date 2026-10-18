"use client";

import {
  approveRecommendationAction,
  dispatchTransferAction,
  failReplenishmentAction,
  failTransferAction,
  generateRecommendationsAction,
  receiveReplenishmentAction,
  receiveTransferAction,
  reissueReplenishmentAction,
  rejectRecommendationAction,
  replenishmentStatusAction,
  resolveLedgerAction,
} from "@/app/actions/distribution";
import { useI18n } from "@/lib/i18n/client";
import { ActionButton, ActionDialogButton } from "./action-dialog";

export function GenerateRecommendationsButton() {
  const { t } = useI18n();
  return <ActionButton label={t("distribution.generate")} action={() => generateRecommendationsAction()} />;
}

export function RecommendationActions({ id, proposed, hasLoan }: { id: string; proposed: number; hasLoan: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <ActionDialogButton
        label={t("distribution.approve")}
        title={t("distribution.approve")}
        description={t("distribution.approveHint")}
        variant="teal"
        fields={[
          ...(hasLoan ? [{ name: "quantity", label: t("distribution.loanQuantity"), type: "number" as const, defaultValue: proposed, min: 1 }] : []),
          { name: "notes", label: `${t("common.notes")} (${t("common.optional")})`, type: "textarea" as const },
        ]}
        action={(v) => approveRecommendationAction({ recommendationId: id, quantity: v.quantity ?? null, notes: v.notes })}
      />
      <ActionDialogButton
        label={t("transfers.reject")}
        title={t("transfers.reject")}
        variant="secondary"
        fields={[{ name: "notes", label: t("common.reason"), type: "textarea" }]}
        submitLabel={t("transfers.reject")}
        action={(v) => rejectRecommendationAction({ recommendationId: id, notes: v.notes })}
      />
    </div>
  );
}

export function TransferLifecycleActions({
  transferId,
  status,
  quantity,
  dispatched,
  canDispatch,
  canReceive,
  canAdmin,
}: {
  transferId: string;
  status: string;
  quantity: number;
  dispatched: number;
  canDispatch: boolean;
  canReceive: boolean;
  canAdmin: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {status === "approved" && canDispatch && (
        <ActionDialogButton
          label={t("distribution.dispatch")}
          title={t("distribution.dispatch")}
          description={t("distribution.dispatchHint")}
          variant="primary"
          fields={[
            { name: "quantity", label: t("common.quantity"), type: "number", defaultValue: quantity, min: 1, max: quantity },
            { name: "notes", label: t("distribution.partialNotes"), type: "textarea" },
          ]}
          action={(v) => dispatchTransferAction({ transferId, quantity: v.quantity, notes: v.notes })}
        />
      )}
      {status === "dispatched" && canReceive && (
        <ActionDialogButton
          label={t("distribution.receive")}
          title={t("distribution.receive")}
          description={t("distribution.receiveHint")}
          variant="teal"
          fields={[
            { name: "quantity", label: t("distribution.quantityReceived"), type: "number", defaultValue: dispatched, min: 1, max: dispatched },
            { name: "notes", label: t("distribution.discrepancyNotes"), type: "textarea" },
          ]}
          action={(v) => receiveTransferAction({ transferId, quantity: v.quantity, notes: v.notes })}
        />
      )}
      {(status === "dispatched" || status === "approved") && canAdmin && (
        <ActionDialogButton
          label={status === "dispatched" ? t("distribution.markFailed") : t("transfers.cancel")}
          title={status === "dispatched" ? t("distribution.markFailed") : t("transfers.cancel")}
          description={status === "dispatched" ? t("distribution.failHint") : undefined}
          variant="secondary"
          fields={[{ name: "reason", label: t("common.reason"), type: "textarea" }]}
          submitLabel={t("common.confirm")}
          action={(v) => failTransferAction({ transferId, reason: v.reason })}
        />
      )}
    </div>
  );
}

export function ReplenishmentActions({
  requestId,
  status,
  outstanding,
  canReceive,
  canAdmin,
}: {
  requestId: string;
  status: string;
  outstanding: number;
  canReceive: boolean;
  canAdmin: boolean;
}) {
  const { t } = useI18n();
  const open = ["requested", "approved", "dispatched", "partially_received"].includes(status);
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {canAdmin && status === "requested" && (
        <ActionButton label={t("distribution.markApproved")} action={() => replenishmentStatusAction({ requestId, status: "approved" })} />
      )}
      {canAdmin && (status === "requested" || status === "approved") && (
        <ActionButton label={t("distribution.markDispatched")} action={() => replenishmentStatusAction({ requestId, status: "dispatched" })} />
      )}
      {canReceive && open && (
        <ActionDialogButton
          label={t("distribution.recordReceipt")}
          title={t("distribution.recordReceipt")}
          description={t("distribution.restorationHint")}
          variant="teal"
          fields={[
            { name: "quantity", label: t("common.quantity"), type: "number", defaultValue: outstanding, min: 1, max: outstanding },
            { name: "batchNumber", label: t("inventory.batchNumber"), type: "text" },
            { name: "expiryDate", label: t("inventory.expiry"), type: "date" },
            { name: "notes", label: `${t("common.notes")} (${t("common.optional")})`, type: "textarea" },
          ]}
          action={(v) => receiveReplenishmentAction({ requestId, quantity: v.quantity, batchNumber: v.batchNumber, expiryDate: v.expiryDate, notes: v.notes })}
        />
      )}
      {canAdmin && open && (
        <ActionDialogButton
          label={t("distribution.markFailed")}
          title={t("distribution.markFailed")}
          variant="secondary"
          fields={[{ name: "reason", label: t("common.reason"), type: "textarea" }]}
          submitLabel={t("common.confirm")}
          action={(v) => failReplenishmentAction({ requestId, reason: v.reason })}
        />
      )}
      {canAdmin && status === "failed" && <ActionButton label={t("distribution.reissue")} variant="primary" action={() => reissueReplenishmentAction({ requestId })} />}
    </div>
  );
}

export function ResolveLedgerButton({ ledgerId }: { ledgerId: string }) {
  const { t } = useI18n();
  return (
    <ActionDialogButton
      label={t("distribution.resolve")}
      title={t("distribution.resolve")}
      description={t("distribution.resolveHint")}
      variant="secondary"
      fields={[{ name: "notes", label: t("common.reason"), type: "textarea" }]}
      submitLabel={t("common.confirm")}
      action={(v) => resolveLedgerAction({ ledgerId, notes: v.notes })}
    />
  );
}
