import { RefreshCw } from "lucide-react"

import { usePathname } from "@/lib/router"
import { SnapshotProvider } from "@/lib/snapshot"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell } from "@/components/layout/app-shell"
import { ConsolePage } from "@/pages/console"
import { LoginPage } from "@/pages/login"
import { TellerPage } from "@/pages/teller"

function App() {
  const pathname = usePathname()

  return (
    <TooltipProvider>
      {pathname === "/login" ? (
        <LoginPage />
      ) : (
        <SnapshotProvider
          fallback={<LoadingScreen />}
          errorFallback={(error, retry) => (
            <main className="grid min-h-screen place-items-center px-4 py-10">
              <div className="grid w-full max-w-md justify-items-start gap-4">
                <Alert variant="emphasis">
                  <AlertTitle>{error}</AlertTitle>
                </Alert>
                <Button variant="outline" onClick={retry}>
                  <RefreshCw />
                  Retry
                </Button>
              </div>
            </main>
          )}
        >
          <AppShell>{pathname.startsWith("/teller") ? <TellerPage /> : <ConsolePage />}</AppShell>
        </SnapshotProvider>
      )}
      <Toaster />
    </TooltipProvider>
  )
}

function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="grid w-full max-w-[760px] gap-3">
        <Skeleton className="h-12" />
        <Skeleton className="h-44" />
        <div className="grid gap-3 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
      </div>
    </main>
  )
}

export default App
