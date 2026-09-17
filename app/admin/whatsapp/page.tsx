import { auth } from "@/auth";
import { redirect } from "next/navigation";

import WhatsAppDashboard from "./WhatsAppDashboard";

export default async function AdminWhatsAppPage() {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = session.user.role;

    if (role !== "ADMIN") {
        redirect("/home");
    }

    return <WhatsAppDashboard />;
}
