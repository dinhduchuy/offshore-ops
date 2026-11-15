"use client";

import { OpsCenter } from "@/components/ops/OpsCenter";
import { I18nProvider } from "@/components/I18nProvider";

export default function OpsPage() {
  return (
    <I18nProvider>
      <OpsCenter />
    </I18nProvider>
  );
}
