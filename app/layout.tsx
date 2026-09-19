import "./globals.css";

import { Toaster } from "react-hot-toast";

import AuthProvider from "@/components/providers/AuthProvider";

/**
 * The application root.
 *
 * It now carries only what the ticketing product needs: session context and the toast host. The
 * retail chrome that used to live here — the storefront `Footer`, the TikTok pixel loader and the
 * legacy `useDialog()` provider — was removed with the retail application. Each surface owns its
 * own chrome instead: ticketing pages render `<SiteShell />`, and the back offices render their
 * dashboard shell.
 */
export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="id">
            <body>
                <AuthProvider>
                    {children}

                    <Toaster
                        position="top-right"
                        toastOptions={{
                            duration: 3000,
                        }}
                    />
                </AuthProvider>
            </body>
        </html>
    );
}
