// Shared server-action result contract. `error` and `message` are i18n keys
// (errors.* / validation.* / any message key) so results translate on the client.

export type ActionResult<T = unknown> =
  | { ok: true; message?: string; params?: Record<string, string | number>; data?: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export const ok = <T,>(message?: string, params?: Record<string, string | number>, data?: T): ActionResult<T> => ({
  ok: true,
  message,
  params,
  data,
});

export const fail = (error: string, fieldErrors?: Record<string, string>): ActionResult<never> => ({
  ok: false,
  error,
  fieldErrors,
});
