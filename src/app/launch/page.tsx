import type { Metadata } from "next";
import { LaunchForm } from "@/components/launch-form";
export const metadata: Metadata = { title: "Launch Token" };
export default function LaunchPage() {
  return <div className="container-shell py-8 md:py-12">
    <LaunchForm />
  </div>;
}
