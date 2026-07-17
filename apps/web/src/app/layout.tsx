import type { Metadata } from "next";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "QDAG",
    template: "%s · QDAG",
  },
  description: "Private experiment provenance and DAG registry.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html className="h-full antialiased" lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
