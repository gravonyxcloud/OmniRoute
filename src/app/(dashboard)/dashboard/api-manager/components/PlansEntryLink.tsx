"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

export default function PlansEntryLink() {
  const t = useTranslations("apiManager");
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-surface p-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-text-main">{t("plansEntryTitle")}</p>
        <p className="mt-1 text-sm text-text-muted">{t("plansEntryHint")}</p>
      </div>
      <Link
        href="/dashboard/api-manager/plans"
        className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="material-symbols-outlined text-lg" aria-hidden="true">
          swagger
        </span>
        {t("plansEntryCta")}
      </Link>
    </div>
  );
}
