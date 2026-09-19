"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { useBrowserValue } from "@/lib/ui/browser-value";
import { Button } from "@/components/dashboard/ui/button";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/components/dashboard/ui/sheet";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/dashboard/ui/misc";

/**
 * ==========================================
 * SIDEBAR
 * ==========================================
 *
 * The shadcn sidebar composition — Provider, Sidebar, Header, Content, Group, Menu, MenuItem,
 * MenuButton, Footer — implemented against the dashboard's own tokens (`bg-sidebar`,
 * `text-sidebar-foreground`, `bg-sidebar-accent`, `border-sidebar-border`, `bg-sidebar-primary`).
 *
 * TWO PRESENTATIONS, ONE MENU
 * ---------------------------
 * The same children render into a persistent `<aside>` at `md` and above and into a `Sheet` below
 * it, so the phone drawer and the desktop rail can never list different destinations. The desktop
 * rail collapses to an icon strip (76px) with a tooltip per row, and the collapsed state is
 * remembered per device in localStorage — a preference, not application state, so it never touches
 * the server.
 *
 * THE NAVIGATION CONTENTS ARE NOT DECIDED HERE. The menu is rendered from the array the caller was
 * given, and that array is built by `DashboardAppShell` from capability booleans the server layout
 * resolved. Nothing in this file reads a session or a permission.
 */

const SIDEBAR_WIDTH = "17.25rem";
const SIDEBAR_WIDTH_COLLAPSED = "4.75rem";
const COLLAPSE_STORAGE_KEY = "tk-dashboard-sidebar-collapsed";

/**
 * The device's stored preference, or `null` when there is none (or storage is unavailable) so the
 * caller can fall back to its own default. Server-safe: `useBrowserValue` only calls this on the
 * client.
 */
function readCollapsedPreference(): boolean | null {
    try {
        const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);

        return stored === null ? null : stored === "true";
    } catch {
        /* storage unavailable */
        return null;
    }
}

type SidebarContextValue = {
    mobileOpen: boolean;
    setMobileOpen: (open: boolean) => void;
    collapsed: boolean;
    toggleCollapsed: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar(): SidebarContextValue {
    const context = React.useContext(SidebarContext);

    if (!context) {
        throw new Error("useSidebar must be used inside SidebarProvider");
    }

    return context;
}

function SidebarProvider({
    children,
    defaultCollapsed = false,
}: {
    children: React.ReactNode;
    defaultCollapsed?: boolean;
}) {
    const [mobileOpen, setMobileOpen] = React.useState(false);

    /*
     * The collapsed flag is a device preference, so it has to come from the browser. Read as a
     * client snapshot rather than restored inside an effect: the server render and the first client
     * pass both use `null` (no preference known, so `defaultCollapsed` applies and the markup
     * matches), and the stored value arrives in the commit right after — the same moment the effect
     * would have run, without a state update inside an effect.
     *
     * `override` is what this session's toggles write, so a click does not wait for a read-back.
     */
    const storedCollapsed = useBrowserValue<boolean | null>(readCollapsedPreference, null);
    const [override, setOverride] = React.useState<boolean | null>(null);

    const collapsed = override ?? storedCollapsed ?? defaultCollapsed;

    const toggleCollapsed = React.useCallback(() => {
        const next = !collapsed;

        try {
            window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
        } catch {
            /* storage unavailable */
        }

        setOverride(next);
    }, [collapsed]);

    const value = React.useMemo(
        () => ({ mobileOpen, setMobileOpen, collapsed, toggleCollapsed }),
        [mobileOpen, collapsed, toggleCollapsed]
    );

    return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

/**
 * The sidebar itself: an `<aside>` from `md` up, and a left-hand `Sheet` below it.
 *
 * `variant="inset"` is not used here — the dashboard wants a full-height band flush against the
 * viewport edge, which is what `bg-sidebar` on a fixed-width column gives.
 */
function Sidebar({ children }: { children: React.ReactNode }) {
    const { mobileOpen, setMobileOpen, collapsed } = useSidebar();

    return (
        <>
            {/* Desktop */}
            <aside
                data-sidebar="sidebar"
                data-state={collapsed ? "collapsed" : "expanded"}
                style={{
                    width: collapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH,
                }}
                className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex"
            >
                {children}
            </aside>

            {/* Mobile / tablet */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetContent side="left" className="w-[17.25rem] p-0">
                    <SheetHeader className="sr-only">
                        <SheetTitle>Navigasi dashboard</SheetTitle>
                        <SheetDescription>Pilih halaman yang ingin dibuka.</SheetDescription>
                    </SheetHeader>

                    {children}
                </SheetContent>
            </Sheet>
        </>
    );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
    const { collapsed } = useSidebar();

    return (
        <div
            data-sidebar="header"
            className={cn(
                "flex shrink-0 items-center gap-2 border-b border-sidebar-border px-3 py-3.5",
                collapsed && "md:justify-center md:px-2",
                className
            )}
            {...props}
        />
    );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-sidebar="content"
            className={cn(
                "flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-3",
                className
            )}
            {...props}
        />
    );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-sidebar="footer"
            className={cn(
                "flex shrink-0 flex-col gap-1 border-t border-sidebar-border px-2 py-3",
                className
            )}
            {...props}
        />
    );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-sidebar="group"
            className={cn("flex flex-col gap-0.5", className)}
            {...props}
        />
    );
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
    const { collapsed } = useSidebar();

    return (
        <div
            data-sidebar="group-label"
            className={cn(
                "px-2.5 pb-1 pt-3 text-[0.6875rem] font-bold uppercase tracking-wider text-sidebar-foreground/45",
                collapsed && "md:hidden",
                className
            )}
            {...props}
        />
    );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
    return (
        <ul data-sidebar="menu" className={cn("flex flex-col gap-0.5", className)} {...props} />
    );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
    return <li data-sidebar="menu-item" className={cn("relative", className)} {...props} />;
}

/**
 * One navigation row.
 *
 * `isActive` is the single highlight the caller computed (the winner among every destination), so a
 * row can never claim to be current twice. When the rail is collapsed the label is rendered inside
 * a tooltip instead of disappearing, which is what keeps an icon-only rail discoverable — and the
 * label is still in the DOM for assistive technology either way.
 */
function SidebarMenuButton({
    asChild = false,
    isActive = false,
    className,
    children,
    tooltip,
    ...props
}: React.ComponentProps<"button"> & {
    asChild?: boolean;
    isActive?: boolean;
    tooltip?: string;
}) {
    const { collapsed } = useSidebar();
    // `asChild` hands the row's props (active state, class, keyboard handler) to the caller's own
    // element — normally a `next/link` — so a navigation row is a real client-side link and never
    // an anchor wrapped in an anchor.
    const Comp = asChild ? Slot : "button";

    const content = (
        <Comp
            data-sidebar="menu-button"
            data-active={isActive ? "true" : undefined}
            aria-current={isActive ? "page" : undefined}
            className={cn(
                "group/row flex w-full items-center gap-3 rounded-field px-3 py-3 text-left text-[0.875rem] font-medium outline-none transition-colors",
                "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                "data-[active=true]:bg-sidebar-primary data-[active=true]:font-semibold data-[active=true]:text-sidebar-primary-foreground",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                collapsed && "md:justify-center md:px-2",
                className
            )}
            {...props}
        >
            {children}
        </Comp>
    );

    if (!tooltip) {
        return content;
    }

    return (
        <Tooltip>
            <TooltipTrigger asChild>{content}</TooltipTrigger>
            <TooltipContent side="right" className="md:hidden">
                {tooltip}
            </TooltipContent>
        </Tooltip>
    );
}

/** The label inside a row, hidden when the rail is collapsed, with its trailing slot. */
function SidebarMenuLabel({
    children,
    trailing,
    className,
}: {
    children: React.ReactNode;
    trailing?: React.ReactNode;
    className?: string;
}) {
    const { collapsed } = useSidebar();

    return (
        <span
            className={cn(
                "flex min-w-0 flex-1 items-center justify-between gap-2",
                collapsed && "md:hidden",
                className
            )}
        >
            <span className="truncate">{children}</span>
            {trailing ? <span className="shrink-0 opacity-70">{trailing}</span> : null}
        </span>
    );
}

/** Opens the mobile drawer. Hidden from `md` up, where the rail is always visible. */
function SidebarTrigger({ className, ...props }: React.ComponentProps<"button">) {
    const { setMobileOpen } = useSidebar();

    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label="Buka menu"
            className={cn("md:hidden", className)}
            onClick={() => setMobileOpen(true)}
            {...props}
        >
            <PanelLeftOpen />
        </Button>
    );
}

/** Collapses the desktop rail to an icon strip. Hidden below `md`. */
function SidebarCollapseToggle({ className }: { className?: string }) {
    const { collapsed, toggleCollapsed } = useSidebar();

    return (
        <Button
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? "Perluas menu" : "Ringkas menu"}
            className={cn(
                "hidden text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:inline-flex",
                className
            )}
            onClick={toggleCollapsed}
        >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
        </Button>
    );
}

export {
    SidebarProvider,
    Sidebar,
    SidebarHeader,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarMenuLabel,
    SidebarTrigger,
    SidebarCollapseToggle,
    useSidebar,
};
