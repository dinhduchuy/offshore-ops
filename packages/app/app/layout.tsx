import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Offshore Ops",
  description: "Điều phối công việc và nhân sự AI cho hoạt động dầu khí offshore",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
