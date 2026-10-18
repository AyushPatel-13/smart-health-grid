export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading…</span>
      <div className="mb-5 h-7 w-64 rounded bg-slate-200" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl border border-line bg-white" />
        ))}
      </div>
      <div className="mt-4 h-72 rounded-xl border border-line bg-white" />
    </div>
  );
}
