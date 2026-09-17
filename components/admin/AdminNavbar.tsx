import {
    FiArrowRight,
    FiBox,
    FiClock,
    FiDisc,
    FiDollarSign,
    FiFileText,
    FiGrid,
    FiHeart,
    FiImage,
    FiMail,
    FiMessageCircle,
    FiPackage,
    FiPercent,
    FiRefreshCw,
    FiSettings,
    FiShoppingBag,
    FiShoppingCart,
    FiStar,
    FiTag,
    FiTarget,
    FiTrendingUp,
    FiTruck,
    FiUserCheck,
    FiUserPlus,
    FiUsers,
    FiZap,
} from "react-icons/fi";

import type { ShellNavEntry } from "@/components/dashboard/DashboardNav";

/**
 * ==========================================
 * ADMIN NAVIGATION DEFINITION
 * ==========================================
 *
 * The `/admin` menu, as data. The Mantine shell renders it (`AdminShell` → `DashboardShell` →
 * `DashboardNav`); this file owns only *which* destinations exist, grouped and labelled exactly as
 * the previous hand-rolled sidebar had them, so nobody has to relearn the menu after the redesign.
 *
 * WHY THE DEFINITION STAYS IN THIS FILE
 * -------------------------------------
 * Four pre-existing suites read this path to assert the admin menu still reaches every back-office
 * surface (broadcasts, affiliate, spin-wheel, discounts). Keeping the source of truth here means
 * those guarantees survive the UI migration instead of being re-pointed at a rendering detail.
 * The file no longer renders anything: the chrome is Mantine now, and there is one renderer for it
 * in `components/dashboard/DashboardNav.tsx`.
 *
 * THE ITEM SET IS DELIBERATELY UNCHANGED — including the fact that it contains **no ticketing
 * entry point**. Two independent reasons:
 *
 *   1. Authority. `app/admin/layout.tsx` gates on the legacy retail `role === "ADMIN"`, while the
 *      ticketing surfaces at `/platform` and `/organizer` authorize on `platformRole` and organiser
 *      membership. `app/platform/layout.tsx` documents why those are separate dimensions and why
 *      deriving one from the other would be a hidden grant. Adding a ticketing link here would
 *      advertise access this role does not have, so the migration preserves the boundary rather
 *      than papering over it.
 *   2. The brief. "A menu item must only appear if the existing authorization/product architecture
 *      permits it. Do NOT create hidden permission bridges."
 *
 * The Broadcast group keeps its query-differentiated entries; the renderer compares their query so
 * only the active one highlights.
 */
export const ADMIN_NAV: ShellNavEntry[] = [
    { label: "Dashboard", href: "/admin", icon: <FiGrid size={18} /> },
    { label: "Produk", href: "/admin/products", icon: <FiBox size={18} /> },
    { label: "Orderan", href: "/admin/orders", icon: <FiShoppingBag size={18} /> },
    { label: "Refund", href: "/admin/refunds", icon: <FiRefreshCw size={18} /> },
    {
        label: "Marketing",
        icon: <FiTarget size={18} />,
        items: [
            { label: "Flash Sale", href: "/admin/flash-sales", icon: <FiZap size={15} /> },
            { label: "Kampanye", href: "/admin/campaigns", icon: <FiTarget size={15} /> },
            { label: "Diskon Produk", href: "/admin/discounts", icon: <FiPercent size={15} /> },
            { label: "Voucher & Promo Code", href: "/admin/vouchers", icon: <FiTag size={15} /> },
            {
                label: "Beli Banyak Lebih Hemat",
                href: "/admin/bulk-discounts",
                icon: <FiShoppingCart size={15} />,
            },
            {
                label: "Diskon Ongkir",
                href: "/admin/shipping-discounts",
                icon: <FiTruck size={15} />,
            },
            { label: "Promosi / Banner", href: "/admin/promotions", icon: <FiImage size={15} /> },
            { label: "Spin Wheel", href: "/admin/spin-wheel", icon: <FiDisc size={15} /> },
        ],
    },
    {
        label: "Broadcast",
        icon: <FiMail size={18} />,
        items: [
            {
                label: "Produk Terlaris",
                href: "/admin/broadcasts?type=BEST_SELLER",
                icon: <FiStar size={15} />,
            },
            {
                label: "Produk Baru",
                href: "/admin/broadcasts?type=NEW_PRODUCT",
                icon: <FiPackage size={15} />,
            },
            {
                label: "Beli Lagi",
                href: "/admin/broadcasts?type=BUY_AGAIN",
                icon: <FiArrowRight size={15} />,
            },
            {
                label: "Pembeli Tidak Aktif",
                href: "/admin/broadcasts?type=INACTIVE_BUYER",
                icon: <FiClock size={15} />,
            },
            {
                label: "Harga Turun",
                href: "/admin/broadcasts?type=PRICE_DROP",
                icon: <FiTrendingUp size={15} />,
            },
            {
                label: "Keranjang",
                href: "/admin/broadcasts?type=CART_REMINDER",
                icon: <FiShoppingBag size={15} />,
            },
            {
                label: "Reminder Checkout",
                href: "/admin/broadcasts?type=CHECKOUT_REMINDER",
                icon: <FiDollarSign size={15} />,
            },
            {
                label: "Terima Kasih",
                href: "/admin/broadcasts?type=THANK_YOU",
                icon: <FiHeart size={15} />,
            },
        ],
    },
    { label: "Reports", href: "/admin/reports", icon: <FiFileText size={18} /> },
    { label: "Pengguna", href: "/admin/users", icon: <FiUsers size={18} /> },
    {
        label: "Affiliator",
        icon: <FiUserPlus size={18} />,
        items: [
            { label: "Pengajuan", href: "/admin/affiliate", icon: <FiUserPlus size={15} /> },
            { label: "Management", href: "/admin/affiliate/manage", icon: <FiUserCheck size={15} /> },
            { label: "Payouts", href: "/admin/affiliate/payouts", icon: <FiDollarSign size={15} /> },
            { label: "Audit Log", href: "/admin/affiliate/audit-log", icon: <FiClock size={15} /> },
        ],
    },
    { label: "WhatsApp", href: "/admin/whatsapp", icon: <FiMessageCircle size={18} /> },
    { label: "Pengaturan", href: "/admin/settings", icon: <FiSettings size={18} /> },
];
