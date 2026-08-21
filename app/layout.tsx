import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "UNICORN",
  description: "UNICORN Survey — Photometric Redshift Catalogs",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="page-wrapper">
          {children}
        </div>
      </body>
    </html>
  );
}
