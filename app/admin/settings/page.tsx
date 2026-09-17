import { auth } from "@/auth";
import { redirect } from "next/navigation";

import AdminSettingsForm from "./AdminSettingsForm";

export default async function AdminSettingsPage() {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = session.user.role;

    if (role !== "ADMIN") {
        redirect("/home");
    }

    return <AdminSettingsForm />;
}